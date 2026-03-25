const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const MONGO_URI = process.env.MONGO_URI;
const DB_FILE = path.join(__dirname, 'db.json');

let db = { employees: [], records: [], presets: {} };
let mongoCol = null;

async function initDB() {
  if (MONGO_URI) {
    try {
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(MONGO_URI);
      await client.connect();
      const col = client.db('vehiclelog').collection('data');
      mongoCol = col;
      const doc = await col.findOne({ _id: 'main' });
      if (doc) {
        db = { employees: doc.employees||[], records: doc.records||[], presets: doc.presets||{} };
      } else {
        await col.insertOne({ _id: 'main', ...db });
      }
      console.log('MongoDB Atlas connected');
    } catch(e) {
      console.error('MongoDB failed:', e.message);
      loadFile();
    }
  } else {
    loadFile();
  }
}

function loadFile() {
  if (fs.existsSync(DB_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE)); if(!db.presets) db.presets={}; } catch(e) {}
  }
}

async function saveDB() {
  if (mongoCol) {
    await mongoCol.replaceOne({ _id: 'main' }, { _id: 'main', ...db }, { upsert: true });
  } else {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }
}

function readBody(req, cb) {
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch(e) { cb({}); } });
}

function sendJSON(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json;charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const { pathname } = url.parse(req.url, true);
  const m = req.method;

  if (m === 'GET' && pathname === '/') {
    try { res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); res.end(fs.readFileSync(path.join(__dirname, 'index.html'))); }
    catch(e) { res.writeHead(500); res.end('index.html not found'); }
    return;
  }
  if (m === 'GET' && pathname === '/api/data') { sendJSON(res, db); return; }

  if (m === 'POST' && pathname === '/api/employee') {
    readBody(req, async b => {
      const name = (b.name || '').trim();
      if (!name) return sendJSON(res, { ok: false, msg: '이름을 입력해주세요' });
      if (db.employees.includes(name)) return sendJSON(res, { ok: false, msg: '이미 등록된 사원입니다' });
      db.employees.push(name);
      await saveDB();
      sendJSON(res, { ok: true, data: db });
    }); return;
  }

  if (m === 'DELETE' && pathname.startsWith('/api/employee/')) {
    const name = decodeURIComponent(pathname.replace('/api/employee/', ''));
    db.employees = db.employees.filter(e => e !== name);
    saveDB().then(() => sendJSON(res, { ok: true, data: db }));
    return;
  }

  if (m === 'POST' && pathname === '/api/preset') {
    readBody(req, async b => { db.presets[b.emp] = b; await saveDB(); sendJSON(res, { ok: true }); });
    return;
  }

  if (m === 'POST' && pathname === '/api/record') {
    readBody(req, async b => {
      b.id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      db.records.push(b);
      await saveDB();
      sendJSON(res, { ok: true, data: db });
    }); return;
  }

  if (m === 'DELETE' && pathname.startsWith('/api/record/')) {
    const id = pathname.replace('/api/record/', '');
    db.records = db.records.filter(r => r.id !== id);
    saveDB().then(() => sendJSON(res, { ok: true, data: db }));
    return;
  }

  res.writeHead(404); res.end('not found');
});

const PORT = process.env.PORT || 3030;
initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Server running on port ' + PORT);
  });
});
