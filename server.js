const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


const uploadDir = path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure Multer for image uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir)
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, uniqueSuffix + path.extname(file.originalname))
  }
});
const upload = multer({ storage: storage });

// Connect to database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

const ADMIN_PASSWORD = 'admin';

// Admin authentication middleware
const adminAuth = (req, res, next) => {
  const password = req.headers['x-admin-password'] || req.query.pw || req.body.admin_password;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

/* =========================================================================
   SOCKET.IO EVENTS
   ========================================================================= */
io.on('connection', (socket) => {
  console.log('Admin Dashboard connected to live updates');
});

// Helper function to emit fresh stats for a specific election
const emitElectionStats = async (electionId) => {
  try {
    const stats = { election_id: electionId, used_tokens: 0, candidates: {}, portfolios: {} };
    
    // Get used tokens
    const tokenRes = await pool.query('SELECT SUM(CASE WHEN has_voted THEN 1 ELSE 0 END) as used FROM tokens WHERE election_id = $1', [electionId]);
    stats.used_tokens = parseInt(tokenRes.rows[0].used) || 0;
    
    // Get abstain votes
    const portRes = await pool.query('SELECT id, abstain_votes FROM portfolios WHERE election_id = $1', [electionId]);
    portRes.rows.forEach(p => stats.portfolios[p.id] = p.abstain_votes);

    // Get candidate votes
    const candRes = await pool.query('SELECT c.id, c.votes FROM candidates c JOIN portfolios p ON c.portfolio_id = p.id WHERE p.election_id = $1', [electionId]);
    candRes.rows.forEach(c => stats.candidates[c.id] = c.votes);
    
    io.emit('election_stats', stats);
  } catch (err) {
    console.error('Error emitting stats', err);
  }
};

/* =========================================================================
   ADMIN ENDPOINTS
   ========================================================================= */

// GET all elections
app.get('/api/admin/elections', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM elections ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB Error' });
  }
});

// POST create election
app.post('/api/admin/elections', adminAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const { rows } = await pool.query('INSERT INTO elections (name, status) VALUES ($1, $2) RETURNING id', [name, 'Draft']);
    res.json({ id: rows[0].id, name, status: 'Draft' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB Error' });
  }
});

// PUT update election status
app.put('/api/admin/elections/:id/status', adminAuth, async (req, res) => {
  const { status } = req.body;
  if (!['Draft', 'Active', 'Closed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    await pool.query('UPDATE elections SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.json({ success: true, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB Error' });
  }
});

// DELETE election
app.delete('/api/admin/elections/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM elections WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB Error' });
  }
});

// GET election details
app.get('/api/admin/elections/:id/details', adminAuth, async (req, res) => {
  const electionId = req.params.id;
  try {
    const elRes = await pool.query('SELECT * FROM elections WHERE id = $1', [electionId]);
    if (elRes.rows.length === 0) return res.status(404).json({ error: 'Election not found' });
    
    const election = elRes.rows[0];
    let responseData = { election, portfolios: [], tokens: { total: 0, used: 0 } };

    const tokenRes = await pool.query('SELECT COUNT(*) as total, SUM(CASE WHEN has_voted THEN 1 ELSE 0 END) as used FROM tokens WHERE election_id = $1', [electionId]);
    responseData.tokens.total = parseInt(tokenRes.rows[0].total) || 0;
    responseData.tokens.used = parseInt(tokenRes.rows[0].used) || 0;

    const portRes = await pool.query('SELECT * FROM portfolios WHERE election_id = $1', [electionId]);
    const portfolios = portRes.rows;

    const candRes = await pool.query('SELECT c.* FROM candidates c JOIN portfolios p ON c.portfolio_id = p.id WHERE p.election_id = $1', [electionId]);
    const candidates = candRes.rows;

    responseData.portfolios = portfolios.map(p => ({
      ...p,
      candidates: candidates.filter(c => c.portfolio_id === p.id)
    }));

    res.json(responseData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB Error' });
  }
});

// POST create portfolio
app.post('/api/admin/portfolios', adminAuth, async (req, res) => {
  const { election_id, name } = req.body;
  if (!election_id || !name) return res.status(400).json({ error: 'Missing data' });
  try {
    const { rows } = await pool.query('INSERT INTO portfolios (election_id, name, abstain_votes) VALUES ($1, $2, 0) RETURNING id', [election_id, name]);
    res.json({ id: rows[0].id, election_id, name, abstain_votes: 0, candidates: [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB Error' });
  }
});

// DELETE portfolio
app.delete('/api/admin/portfolios/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM portfolios WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB Error' });
  }
});

// POST create candidate
app.post('/api/admin/candidates', upload.single('photo'), adminAuth, async (req, res) => {
  const { portfolio_id, name, bio } = req.body;
  if (!portfolio_id || !name) return res.status(400).json({ error: 'Missing portfolio_id or name' });
  const photo_url = req.file ? `/uploads/${req.file.filename}` : null;
  try {
    const { rows } = await pool.query(
      'INSERT INTO candidates (portfolio_id, name, bio, photo_url) VALUES ($1, $2, $3, $4) RETURNING id', 
      [portfolio_id, name, bio || '', photo_url]
    );
    res.json({ id: rows[0].id, portfolio_id, name, bio, photo_url, votes: 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB Error' });
  }
});

// DELETE candidate
app.delete('/api/admin/candidates/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM candidates WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB Error' });
  }
});

// POST generate tokens
app.post('/api/admin/tokens/generate', adminAuth, async (req, res) => {
  const { election_id, count } = req.body;
  if (!election_id || !count) return res.status(400).json({ error: 'Missing data' });

  const tokens = Array.from({ length: count }, () => crypto.randomBytes(6).toString('hex'));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const t of tokens) {
      await client.query('INSERT INTO tokens (election_id, token, has_voted) VALUES ($1, $2, FALSE)', [election_id, t]);
    }
    await client.query('COMMIT');
    res.json({ success: true, count });
  } catch (err) {
    console.error(err);
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'DB Error' });
  } finally {
    client.release();
  }
});

// POST generate and send tokens via email
app.post('/api/admin/tokens/email', adminAuth, async (req, res) => {
  const { election_id, emails } = req.body;
  if (!election_id || !emails || !Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid data' });
  }

  try {
    const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  tls: {
    rejectUnauthorized: false
  }
});

    const results = { sent: 0, failed: 0, previewUrl: null };
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const tokensToEmail = emails.map(email => ({
      email: email.trim(),
      token: crypto.randomBytes(6).toString('hex')
    }));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of tokensToEmail) {
         await client.query('INSERT INTO tokens (election_id, token, sent_to, has_voted) VALUES ($1, $2, $3, FALSE)', [election_id, item.token, item.email]);
      }
      await client.query('COMMIT');
      
      let lastPreviewUrl = null;
      for (const item of tokensToEmail) {
        try {
          const voteLink = `${baseUrl}/?token=${item.token}`;
          const info = await transporter.sendMail({
            from: '"NAGS Voting System" <admin@nagsvoting.com>',
            to: item.email,
            subject: "Your Secure Voting Link - NAGS Election",
            text: `Hello,\n\nPlease cast your vote securely using this link: ${voteLink}\n\nDo not share this link with anyone.`,
            html: `
              <div style="font-family: Arial, sans-serif; padding: 20px; text-align: center; background-color: #f9fafa;">
                <h2 style="color: #2563eb;">NAGS Association Election</h2>
                <p>Hello,</p>
                <p>You have been invited to cast your ballot securely and anonymously.</p>
                <a href="${voteLink}" style="display: inline-block; margin-top: 20px; padding: 12px 24px; background-color: #2563eb; color: #fff; text-decoration: none; border-radius: 6px; font-weight: bold;">Click Here to Vote</a>
                <p style="margin-top: 30px; font-size: 12px; color: #666;">This link is unique to you. Do not share it with anyone.</p>
              </div>
            `
          });
          results.sent++;
          lastPreviewUrl = nodemailer.getTestMessageUrl(info);
        } catch (e) {
          console.error(e);
          results.failed++;
        }
      }
      
      results.previewUrl = lastPreviewUrl;
      res.json(results);
    } catch (err) {
      console.error(err);
      await client.query('ROLLBACK');
      res.status(500).json({ error: 'DB Error' });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to configure email service' });
  }
});

// GET export tokens CSV
app.get('/api/admin/tokens/export/:electionId', adminAuth, async (req, res) => {
  const electionId = req.params.electionId;
  try {
    const { rows } = await pool.query('SELECT token, sent_to, has_voted FROM tokens WHERE election_id = $1', [electionId]);
    
    let csv = 'TokenLink,SentTo,Status\n';
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    rows.forEach(r => {
      const link = `${baseUrl}/?token=${r.token}`;
      const status = r.has_voted ? 'Voted' : 'Unused';
      const sentTo = r.sent_to || 'Generated Manually';
      csv += `"${link}","${sentTo}","${status}"\n`;
    });

    res.header('Content-Type', 'text/csv');
    res.attachment(`election_${electionId}_tokens.csv`);
    return res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB Error' });
  }
});

/* =========================================================================
   VOTER ENDPOINTS
   ========================================================================= */

app.get('/api/election/:token', async (req, res) => {
  const tokenStr = req.params.token;

  try {
    const tokenRes = await pool.query('SELECT * FROM tokens WHERE token = $1', [tokenStr]);
    if (tokenRes.rows.length === 0) return res.status(404).json({ error: 'Invalid token' });
    const token = tokenRes.rows[0];
    if (token.has_voted) return res.status(403).json({ error: 'Token has already been used to vote' });

    const elRes = await pool.query('SELECT * FROM elections WHERE id = $1', [token.election_id]);
    if (elRes.rows.length === 0) return res.status(500).json({ error: 'DB Error' });
    const election = elRes.rows[0];
    
    if (election.status === 'Draft') return res.status(403).json({ error: 'This election has not started yet.' });
    if (election.status === 'Closed') return res.status(403).json({ error: 'This election has ended.' });

    const portRes = await pool.query('SELECT * FROM portfolios WHERE election_id = $1', [election.id]);
    const portfolios = portRes.rows;

    const candRes = await pool.query('SELECT c.id, c.portfolio_id, c.name, c.bio, c.photo_url FROM candidates c JOIN portfolios p ON c.portfolio_id = p.id WHERE p.election_id = $1', [election.id]);
    const candidates = candRes.rows;

    const portfoliosData = portfolios.map(p => ({
      ...p,
      candidates: candidates.filter(c => c.portfolio_id === p.id)
    }));

    res.json({ election, portfolios: portfoliosData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB Error' });
  }
});

app.post('/api/vote', async (req, res) => {
  const { token, votes } = req.body; 

  if (!token || !votes || Object.keys(votes).length === 0) {
    return res.status(400).json({ error: 'Token and votes are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tokenRes = await client.query('SELECT * FROM tokens WHERE token = $1 FOR UPDATE', [token]);
    if (tokenRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invalid token' });
    }
    const tokenRow = tokenRes.rows[0];
    if (tokenRow.has_voted) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Token has already been used' });
    }

    const electionId = tokenRow.election_id;

    const elRes = await client.query('SELECT status FROM elections WHERE id = $1', [electionId]);
    if (elRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'DB Error' });
    }
    const election = elRes.rows[0];
    if (election.status !== 'Active') {
       await client.query('ROLLBACK');
       return res.status(403).json({ error: 'Election is not active.' });
    }

    const portRes = await client.query('SELECT id FROM portfolios WHERE election_id = $1', [electionId]);
    const portfolios = portRes.rows;

    const requiredPortfolioIds = portfolios.map(p => p.id.toString());
    const votedPortfolioIds = Object.keys(votes);

    const hasAll = requiredPortfolioIds.every(id => votedPortfolioIds.includes(id));
    if (!hasAll) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You must select a candidate or abstain for every portfolio.' });
    }

    const entries = Object.entries(votes);
    for (const [portId, choiceId] of entries) {
      if (choiceId === 'abstain') {
        await client.query('UPDATE portfolios SET abstain_votes = abstain_votes + 1 WHERE id = $1', [portId]);
      } else {
        await client.query('UPDATE candidates SET votes = votes + 1 WHERE id = $1 AND portfolio_id = $2', [choiceId, portId]);
      }
    }

    await client.query('UPDATE tokens SET has_voted = TRUE WHERE token = $1', [token]);
    await client.query('COMMIT');
    
    res.json({ success: true });
    
    // Fire live update event via Socket.io
    emitElectionStats(electionId);
  } catch (err) {
    console.error(err);
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'DB Error' });
  } finally {
    client.release();
  }
});

// VERY IMPORTANT: Use 'server.listen' instead of 'app.listen' because of socket.io
server.listen(PORT, () => {
  console.log(`NAGS Voting System server running at http://localhost:${PORT}`);
});
