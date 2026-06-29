const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configure Multer for image uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'public/uploads/')
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, uniqueSuffix + path.extname(file.originalname))
  }
});
const upload = multer({ storage: storage });

// Connect to database
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) console.error('Error opening database', err.message);
});

// Enable foreign keys
db.run('PRAGMA foreign_keys = ON');

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
const emitElectionStats = (electionId) => {
  db.serialize(() => {
    const stats = { election_id: electionId, used_tokens: 0, candidates: {}, portfolios: {} };
    
    // Get used tokens
    db.get('SELECT SUM(has_voted) as used FROM tokens WHERE election_id = ?', [electionId], (err, row) => {
      if (!err) stats.used_tokens = row.used || 0;
      
      // Get abstain votes
      db.all('SELECT id, abstain_votes FROM portfolios WHERE election_id = ?', [electionId], (err, portfolios) => {
        if (!err) portfolios.forEach(p => stats.portfolios[p.id] = p.abstain_votes);

        // Get candidate votes
        db.all('SELECT c.id, c.votes FROM candidates c JOIN portfolios p ON c.portfolio_id = p.id WHERE p.election_id = ?', [electionId], (err, candidates) => {
          if (!err) candidates.forEach(c => stats.candidates[c.id] = c.votes);
          
          // Emit the live update event to all connected dashboards
          io.emit('election_stats', stats);
        });
      });
    });
  });
};

/* =========================================================================
   ADMIN ENDPOINTS
   ========================================================================= */

// GET all elections
app.get('/api/admin/elections', adminAuth, (req, res) => {
  db.all('SELECT * FROM elections ORDER BY created_at DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB Error' });
    res.json(rows);
  });
});

// POST create election
app.post('/api/admin/elections', adminAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  db.run('INSERT INTO elections (name, status) VALUES (?, ?)', [name, 'Draft'], function(err) {
    if (err) return res.status(500).json({ error: 'DB Error' });
    res.json({ id: this.lastID, name, status: 'Draft' });
  });
});

// PUT update election status
app.put('/api/admin/elections/:id/status', adminAuth, (req, res) => {
  const { status } = req.body;
  if (!['Draft', 'Active', 'Closed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  db.run('UPDATE elections SET status = ? WHERE id = ?', [status, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'DB Error' });
    res.json({ success: true, status });
  });
});

// DELETE election
app.delete('/api/admin/elections/:id', adminAuth, (req, res) => {
  db.run('DELETE FROM elections WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'DB Error' });
    res.json({ success: true });
  });
});

// GET election details
app.get('/api/admin/elections/:id/details', adminAuth, (req, res) => {
  const electionId = req.params.id;
  
  db.serialize(() => {
    db.get('SELECT * FROM elections WHERE id = ?', [electionId], (err, election) => {
      if (err) return res.status(500).json({ error: 'DB Error' });
      if (!election) return res.status(404).json({ error: 'Election not found' });

      let responseData = { election, portfolios: [], tokens: { total: 0, used: 0 } };

      db.get('SELECT COUNT(*) as total, SUM(has_voted) as used FROM tokens WHERE election_id = ?', [electionId], (err, row) => {
        if (err) return res.status(500).json({ error: 'DB Error' });
        responseData.tokens.total = row.total;
        responseData.tokens.used = row.used || 0;
      });

      db.all('SELECT * FROM portfolios WHERE election_id = ?', [electionId], (err, portfolios) => {
        if (err) return res.status(500).json({ error: 'DB Error' });
        
        db.all(`SELECT c.* FROM candidates c JOIN portfolios p ON c.portfolio_id = p.id WHERE p.election_id = ?`, [electionId], (err, candidates) => {
          if (err) return res.status(500).json({ error: 'DB Error' });

          responseData.portfolios = portfolios.map(p => ({
            ...p,
            candidates: candidates.filter(c => c.portfolio_id === p.id)
          }));

          res.json(responseData);
        });
      });
    });
  });
});

// POST create portfolio
app.post('/api/admin/portfolios', adminAuth, (req, res) => {
  const { election_id, name } = req.body;
  if (!election_id || !name) return res.status(400).json({ error: 'Missing data' });
  db.run('INSERT INTO portfolios (election_id, name, abstain_votes) VALUES (?, ?, 0)', [election_id, name], function(err) {
    if (err) return res.status(500).json({ error: 'DB Error' });
    res.json({ id: this.lastID, election_id, name, abstain_votes: 0, candidates: [] });
  });
});

// DELETE portfolio
app.delete('/api/admin/portfolios/:id', adminAuth, (req, res) => {
  db.run('DELETE FROM portfolios WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'DB Error' });
    res.json({ success: true });
  });
});

// POST create candidate
app.post('/api/admin/candidates', upload.single('photo'), adminAuth, (req, res) => {
  const { portfolio_id, name, bio } = req.body;
  if (!portfolio_id || !name) return res.status(400).json({ error: 'Missing portfolio_id or name' });
  const photo_url = req.file ? `/uploads/${req.file.filename}` : null;
  db.run('INSERT INTO candidates (portfolio_id, name, bio, photo_url) VALUES (?, ?, ?, ?)', 
    [portfolio_id, name, bio || '', photo_url], 
    function(err) {
      if (err) return res.status(500).json({ error: 'DB Error' });
      res.json({ id: this.lastID, portfolio_id, name, bio, photo_url, votes: 0 });
    }
  );
});

// DELETE candidate
app.delete('/api/admin/candidates/:id', adminAuth, (req, res) => {
  db.run('DELETE FROM candidates WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'DB Error' });
    res.json({ success: true });
  });
});

// POST generate tokens
app.post('/api/admin/tokens/generate', adminAuth, (req, res) => {
  const { election_id, count } = req.body;
  if (!election_id || !count) return res.status(400).json({ error: 'Missing data' });

  const tokens = Array.from({ length: count }, () => crypto.randomBytes(6).toString('hex'));

  const stmt = db.prepare('INSERT INTO tokens (election_id, token, has_voted) VALUES (?, ?, 0)');
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    tokens.forEach(t => stmt.run(election_id, t));
    stmt.finalize();
    db.run('COMMIT', (err) => {
      if (err) return res.status(500).json({ error: 'DB Error' });
      res.json({ success: true, count });
    });
  });
});

// POST generate and send tokens via email
app.post('/api/admin/tokens/email', adminAuth, async (req, res) => {
  const { election_id, emails } = req.body;
  if (!election_id || !emails || !Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid data' });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    const results = { sent: 0, failed: 0, previewUrl: null };
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const stmt = db.prepare('INSERT INTO tokens (election_id, token, sent_to, has_voted) VALUES (?, ?, ?, 0)');
    
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      
      const tokensToEmail = emails.map(email => ({
        email: email.trim(),
        token: crypto.randomBytes(6).toString('hex')
      }));

      tokensToEmail.forEach(item => stmt.run(election_id, item.token, item.email));
      stmt.finalize();

      db.run('COMMIT', async (err) => {
        if (err) return res.status(500).json({ error: 'DB Error' });

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
            results.failed++;
          }
        }
        
        results.previewUrl = lastPreviewUrl;
        res.json(results);
      });
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to configure email service' });
  }
});

// GET export tokens CSV
app.get('/api/admin/tokens/export/:electionId', adminAuth, (req, res) => {
  const electionId = req.params.electionId;
  db.all('SELECT token, sent_to, has_voted FROM tokens WHERE election_id = ?', [electionId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB Error' });
    
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
  });
});

/* =========================================================================
   VOTER ENDPOINTS
   ========================================================================= */

app.get('/api/election/:token', (req, res) => {
  const tokenStr = req.params.token;

  db.get('SELECT * FROM tokens WHERE token = ?', [tokenStr], (err, token) => {
    if (err) return res.status(500).json({ error: 'DB Error' });
    if (!token) return res.status(404).json({ error: 'Invalid token' });
    if (token.has_voted) return res.status(403).json({ error: 'Token has already been used to vote' });

    db.get('SELECT * FROM elections WHERE id = ?', [token.election_id], (err, election) => {
      if (err) return res.status(500).json({ error: 'DB Error' });
      if (election.status === 'Draft') return res.status(403).json({ error: 'This election has not started yet.' });
      if (election.status === 'Closed') return res.status(403).json({ error: 'This election has ended.' });

      db.all('SELECT * FROM portfolios WHERE election_id = ?', [election.id], (err, portfolios) => {
        if (err) return res.status(500).json({ error: 'DB Error' });

        db.all('SELECT c.id, c.portfolio_id, c.name, c.bio, c.photo_url FROM candidates c JOIN portfolios p ON c.portfolio_id = p.id WHERE p.election_id = ?', [election.id], (err, candidates) => {
          if (err) return res.status(500).json({ error: 'DB Error' });

          const portfoliosData = portfolios.map(p => ({
            ...p,
            candidates: candidates.filter(c => c.portfolio_id === p.id)
          }));

          res.json({ election, portfolios: portfoliosData });
        });
      });
    });
  });
});

app.post('/api/vote', (req, res) => {
  const { token, votes } = req.body; 

  if (!token || !votes || Object.keys(votes).length === 0) {
    return res.status(400).json({ error: 'Token and votes are required' });
  }

  db.serialize(() => {
    db.run('BEGIN EXCLUSIVE TRANSACTION');

    db.get('SELECT * FROM tokens WHERE token = ?', [token], (err, tokenRow) => {
      if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: 'DB Error' }); }
      if (!tokenRow) { db.run('ROLLBACK'); return res.status(404).json({ error: 'Invalid token' }); }
      if (tokenRow.has_voted) { db.run('ROLLBACK'); return res.status(403).json({ error: 'Token has already been used' }); }

      const electionId = tokenRow.election_id;

      db.get('SELECT status FROM elections WHERE id = ?', [electionId], (err, election) => {
        if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: 'DB Error' }); }
        if (election.status !== 'Active') {
           db.run('ROLLBACK'); return res.status(403).json({ error: 'Election is not active.' });
        }

        db.all('SELECT id FROM portfolios WHERE election_id = ?', [electionId], (err, portfolios) => {
          if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: 'DB Error' }); }

          const requiredPortfolioIds = portfolios.map(p => p.id.toString());
          const votedPortfolioIds = Object.keys(votes);

          const hasAll = requiredPortfolioIds.every(id => votedPortfolioIds.includes(id));
          if (!hasAll) {
            db.run('ROLLBACK');
            return res.status(400).json({ error: 'You must select a candidate or abstain for every portfolio.' });
          }

          const candidateStmt = db.prepare('UPDATE candidates SET votes = votes + 1 WHERE id = ? AND portfolio_id = ?');
          const abstainStmt = db.prepare('UPDATE portfolios SET abstain_votes = abstain_votes + 1 WHERE id = ?');
          
          let updateCount = 0;
          let updateError = false;

          const finalizeTransaction = () => {
            if (updateError) {
               db.run('ROLLBACK');
               return res.status(500).json({ error: 'Failed to record votes' });
            }
            db.run('UPDATE tokens SET has_voted = 1 WHERE token = ?', [token], function(err) {
              if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: 'DB Error' }); }
              db.run('COMMIT', (err) => {
                if (err) return res.status(500).json({ error: 'Failed to commit' });
                res.json({ success: true });
                
                // Fire live update event via Socket.io
                emitElectionStats(electionId);
              });
            });
          };

          const entries = Object.entries(votes);
          if (entries.length === 0) return finalizeTransaction();

          entries.forEach(([portId, choiceId]) => {
            if (choiceId === 'abstain') {
              abstainStmt.run([portId], function(err) {
                if (err) updateError = true;
                updateCount++;
                if (updateCount === entries.length) { candidateStmt.finalize(); abstainStmt.finalize(); finalizeTransaction(); }
              });
            } else {
              candidateStmt.run([choiceId, portId], function(err) {
                if (err) updateError = true;
                updateCount++;
                if (updateCount === entries.length) { candidateStmt.finalize(); abstainStmt.finalize(); finalizeTransaction(); }
              });
            }
          });
        });
      });
    });
  });
});

// VERY IMPORTANT: Use 'server.listen' instead of 'app.listen' because of socket.io
server.listen(port, () => {
  console.log(`NAGS Voting System server running at http://localhost:${port}`);
});
