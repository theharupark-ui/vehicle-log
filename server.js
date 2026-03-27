const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ── DB: MongoDB Atlas 또는 로컬 파일 자동 전환 ──
const MONGO_URI = process.env.MONGO_URI;
const DB_FILE = path.join(__dirname, 'db.json');

let db = { employees: [], records: [], presets: {} };
let mongoCol = null;

async function initDB() {
  if (MONGO_URI) {
    try {
      // MongoDB 드라이버 동적 로드
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(MONGO_URI);
      await client.connect();
      const col = client.db('vehiclelog').collection('data');
      mongoCol = col;
      // 기존 데이터 로드
      const doc = await col.findOne({ _id: 'main' });
      if (doc) {
        db = { employees: doc.employees||[], records: doc.records||[], presets: doc.presets||{} };
      } else {
        await col.insertOne({ _id: 'main', ...db });
      }
      console.log('✅ MongoDB Atlas 연결됨');
    } catch(e) {
      console.error('MongoDB 연결 실패, 파일 DB로 fallback:', e.message);
      loadFile();
    }
  } else {
    loadFile();
    console.log('📁 로컬 파일 DB 사용 중 (db.json)');
  }
}

function loadFile() {
  if (fs.existsSync(DB_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE)); if(!db.presets) db.presets={}; }
    catch(e) {}
  }
}

async function saveDB() {
  if (mongoCol) {
    await mongoCol.replaceOne({ _id: 'main' }, { _id: 'main', ...db }, { upsert: true });
  } else {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }
}

// ── HTTP 서버 ──
function readBody(req, cb) {
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch(e) { cb({}); } });
}

function sendJSON(res, data, code = 200) {
  res.writeHead(code, {
    'Content-Type': 'application/json;charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

// ── 카카오 REST API 서버사이드 호출 헬퍼 ──
function kakaoFetch(apiPath) {
  const restKey = process.env.KAKAO_REST_KEY;
  if (!restKey) return Promise.resolve(null);
  return new Promise((resolve) => {
    const fullUrl = `https://dapi.kakao.com${apiPath}`;
    const req = https.get(fullUrl, {
      headers: { Authorization: `KakaoAK ${restKey}` }
    }, (r) => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const { pathname, query } = url.parse(req.url, true);
  const m = req.method;

  // HTML
  if (m === 'GET' && pathname === '/') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    } catch(e) { res.writeHead(500); res.end('index.html not found'); }
    return;
  }

  // GET /api/data
  if (m === 'GET' && pathname === '/api/data') {
    sendJSON(res, db); return;
  }

  // GET /api/geocode?q=주소 (카카오 REST API 서버 프록시 — CORS 없음)
  if (m === 'GET' && pathname === '/api/geocode') {
    const q = (query.q || '').trim();
    if (!q) { sendJSON(res, { ok: false, msg: 'NO_QUERY' }); return; }
    const restKey = process.env.KAKAO_REST_KEY;
    if (!restKey) { sendJSON(res, { ok: false, msg: 'NO_KEY' }); return; }

    (async () => {
      try {
        // 1) 주소 검색 (도로명·지번 주소)
        const a = await kakaoFetch(`/v2/local/search/address.json?query=${encodeURIComponent(q)}&size=1`);
        if (a?.documents?.[0]) {
          const d = a.documents[0];
          const lat = parseFloat(d.y), lon = parseFloat(d.x);
          if (lat && lon) {
            console.log(`[지오코드] "${q}" → 주소검색 성공 (${lat}, ${lon})`);
            sendJSON(res, { ok: true, lat, lon, name: d.address_name });
            return;
          }
        }
        // 2) 키워드 검색 (건물명, 장소명 등)
        const k = await kakaoFetch(`/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&size=1`);
        if (k?.documents?.[0]) {
          const d = k.documents[0];
          const lat = parseFloat(d.y), lon = parseFloat(d.x);
          if (lat && lon) {
            console.log(`[지오코드] "${q}" → 키워드검색 성공 (${lat}, ${lon})`);
            sendJSON(res, { ok: true, lat, lon, name: d.place_name });
            return;
          }
        }
        console.log(`[지오코드] "${q}" → 검색 실패`);
        sendJSON(res, { ok: false, msg: 'NOT_FOUND' });
      } catch(e) {
        console.error('[지오코드] 오류:', e.message);
        sendJSON(res, { ok: false, msg: e.message });
      }
    })();
    return;
  }

  // POST /api/employee
  if (m === 'POST' && pathname === '/api/employee') {
    readBody(req, async b => {
      const name = (b.name || '').trim();
      if (!name) return sendJSON(res, { ok: false, msg: '이름을 입력해주세요' });
      if (db.employees.includes(name)) return sendJSON(res, { ok: false, msg: '이미 등록된 사원입니다' });
      db.employees.push(name);
      await saveDB();
      console.log(`[사원추가] ${name}`);
      sendJSON(res, { ok: true, data: db });
    }); return;
  }

  // DELETE /api/employee/:name
  if (m === 'DELETE' && pathname.startsWith('/api/employee/')) {
    const name = decodeURIComponent(pathname.replace('/api/employee/', ''));
    db.employees = db.employees.filter(e => e !== name);
    saveDB().then(() => sendJSON(res, { ok: true, data: db }));
    return;
  }

  // POST /api/preset
  if (m === 'POST' && pathname === '/api/preset') {
    readBody(req, async b => {
      db.presets[b.emp] = b;
      await saveDB();
      sendJSON(res, { ok: true });
    }); return;
  }

  // POST /api/record
  if (m === 'POST' && pathname === '/api/record') {
    readBody(req, async b => {
      b.id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      db.records.push(b);
      await saveDB();
      console.log(`[기록추가] ${b.emp} / ${b.date} / ${b.type}`);
      sendJSON(res, { ok: true, data: db });
    }); return;
  }

  // DELETE /api/record/:id
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
    console.log(`\n🚗 차량업무일지 서버 실행 중`);
    console.log(`📍 로컬: http://localhost:${PORT}`);
    console.log(`📡 배포: Railway + MongoDB Atlas`);
    console.log(`🗺  카카오 geocode: ${process.env.KAKAO_REST_KEY ? '✅ 활성화' : '❌ KAKAO_REST_KEY 없음'}\n`);
  });
});
