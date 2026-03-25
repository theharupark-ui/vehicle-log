const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const init = { employees: [], records: [], presets: {} };
    fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
    return init;
  }
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!d.presets) d.presets = {};
    if (!d.employees) d.employees = [];
    if (!d.records) d.records = [];
    return d;
  } catch(e) {
    console.error('data.json 파싱 오류:', e);
    return { employees: [], records: [], presets: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function readBody(req, cb) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try { cb(null, JSON.parse(body)); }
    catch(e) { cb(e, null); }
  });
}

function sendJSON(res, data, code = 200) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // HTML
  if (method === 'GET' && pathname === '/') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) {
      res.writeHead(500); res.end('index.html not found');
    }
    return;
  }

  // GET /api/employees
  if (method === 'GET' && pathname === '/api/employees') {
    const d = loadData();
    sendJSON(res, { ok: true, employees: d.employees });
    return;
  }

  // POST /api/employees  { name: "홍길동" }
  if (method === 'POST' && pathname === '/api/employees') {
    readBody(req, (err, body) => {
      if (err || !body || !body.name) {
        sendJSON(res, { ok: false, error: '이름이 없습니다' }, 400);
        return;
      }
      const d = loadData();
      const name = body.name.trim();
      if (!name) { sendJSON(res, { ok: false, error: '빈 이름' }, 400); return; }
      if (d.employees.includes(name)) {
        sendJSON(res, { ok: false, error: '이미 존재하는 사원입니다' });
        return;
      }
      d.employees.push(name);
      saveData(d);
      console.log(`[사원 추가] ${name}`);
      sendJSON(res, { ok: true, employees: d.employees });
    });
    return;
  }

  // DELETE /api/employees/:name
  if (method === 'DELETE' && pathname.startsWith('/api/employees/')) {
    const name = decodeURIComponent(pathname.replace('/api/employees/', ''));
    const d = loadData();
    d.employees = d.employees.filter(e => e !== name);
    saveData(d);
    console.log(`[사원 삭제] ${name}`);
    sendJSON(res, { ok: true, employees: d.employees });
    return;
  }

  // GET /api/presets
  if (method === 'GET' && pathname === '/api/presets') {
    const d = loadData();
    sendJSON(res, { ok: true, presets: d.presets });
    return;
  }

  // POST /api/presets
  if (method === 'POST' && pathname === '/api/presets') {
    readBody(req, (err, body) => {
      if (err || !body) { sendJSON(res, { ok: false }, 400); return; }
      const d = loadData();
      d.presets[body.employee] = body;
      saveData(d);
      sendJSON(res, { ok: true });
    });
    return;
  }

  // GET /api/records?employee=&year=&month=
  if (method === 'GET' && pathname === '/api/records') {
    const d = loadData();
    const { employee, year, month } = parsed.query;
    let records = [...d.records];
    if (employee) records = records.filter(r => r.employee === employee);
    if (year && month) {
      const prefix = `${year}-${String(month).padStart(2,'0')}`;
      records = records.filter(r => r.date && r.date.startsWith(prefix));
    }
    records.sort((a, b) => b.date > a.date ? 1 : -1);
    sendJSON(res, { ok: true, records });
    return;
  }

  // POST /api/records
  if (method === 'POST' && pathname === '/api/records') {
    readBody(req, (err, body) => {
      if (err || !body) { sendJSON(res, { ok: false }, 400); return; }
      const d = loadData();
      body.id = `${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      body.createdAt = new Date().toISOString();
      d.records.push(body);
      saveData(d);
      console.log(`[기록 추가] ${body.employee} / ${body.date} / ${body.type}`);
      sendJSON(res, { ok: true, id: body.id });
    });
    return;
  }

  // DELETE /api/records/:id
  if (method === 'DELETE' && pathname.startsWith('/api/records/')) {
    const id = pathname.replace('/api/records/', '');
    const d = loadData();
    const before = d.records.length;
    d.records = d.records.filter(r => r.id !== id);
    saveData(d);
    console.log(`[기록 삭제] id=${id} (${before - d.records.length}건 삭제)`);
    sendJSON(res, { ok: true });
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

const PORT = process.env.PORT || 3030;
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ✅ 차량업무일지 서버 실행 중');
  console.log(`  📍 로컬:   http://localhost:${PORT}`);
  console.log(`  📡 공유:   npx ngrok http ${PORT}`);
  console.log('');
});
