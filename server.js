const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ── 네이버 API 키 설정 ──
// 네이버 클라우드 플랫폼(https://developers.naver.com)에서 발급받은 키를 입력하세요
// 또는 환경변수로 설정: set NAVER_CLIENT_ID=xxxxx && set NAVER_CLIENT_SECRET=xxxxx
const NAVER_CLIENT_ID     = process.env.NAVER_CLIENT_ID     || '';
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || '';

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

  // GET /api/place-search?q=검색어  ── 네이버 지역검색 API 프록시
  if (m === 'GET' && pathname === '/api/place-search') {
    const q = (query.q || '').trim();
    if (!q) { sendJSON(res, { items: [], source: 'empty' }); return; }

    if (NAVER_CLIENT_ID && NAVER_CLIENT_SECRET) {
      // 네이버 지역검색 API 호출
      const apiPath = '/v1/search/local.json?query=' + encodeURIComponent(q) + '&display=10&sort=comment';
      const options = {
        hostname: 'openapi.naver.com',
        path: apiPath,
        headers: {
          'X-Naver-Client-Id': NAVER_CLIENT_ID,
          'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
          'User-Agent': 'NaverLocalSearch/1.0'
        }
      };
      const apiReq = https.get(options, apiRes => {
        let data = '';
        apiRes.on('data', c => data += c);
        apiRes.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const items = (parsed.items || []).map(item => ({
              name:     item.title.replace(/<[^>]*>/g, ''),
              address:  item.roadAddress || item.address || '',
              category: item.category || '',
              mapx:     item.mapx,
              mapy:     item.mapy
            }));
            sendJSON(res, { items, source: 'naver' });
          } catch(e) {
            sendJSON(res, { items: [], source: 'error' });
          }
        });
      });
      apiReq.on('error', () => sendJSON(res, { items: [], source: 'error' }));
    } else {
      // API 키 없을 때 → 오프라인 행정구역 검색 fallback
      const REGIONS = [
        '서울 강남구','서울 강북구','서울 강동구','서울 강서구','서울 관악구','서울 광진구',
        '서울 구로구','서울 금천구','서울 노원구','서울 도봉구','서울 동대문구','서울 동작구',
        '서울 마포구','서울 서대문구','서울 서초구','서울 성동구','서울 성북구','서울 송파구',
        '서울 양천구','서울 영등포구','서울 용산구','서울 은평구','서울 종로구','서울 중구','서울 중랑구',
        '경기 수원시','경기 성남시','경기 안양시','경기 안산시','경기 용인시','경기 부천시',
        '경기 광명시','경기 평택시','경기 과천시','경기 오산시','경기 시흥시','경기 군포시',
        '경기 의왕시','경기 하남시','경기 이천시','경기 안성시','경기 김포시','경기 화성시',
        '경기 광주시','경기 양주시','경기 포천시','경기 여주시','경기 고양시','경기 의정부시',
        '경기 구리시','경기 남양주시','경기 파주시','용인시 처인구','용인시 기흥구','용인시 수지구',
        '인천 중구','인천 동구','인천 미추홀구','인천 연수구','인천 남동구','인천 부평구',
        '인천 계양구','인천 서구','인천 강화군','인천 옹진군',
        '부산 중구','부산 서구','부산 동구','부산 영도구','부산 부산진구','부산 동래구',
        '부산 남구','부산 북구','부산 해운대구','부산 사하구','부산 금정구','부산 연제구',
        '대구 중구','대구 동구','대구 서구','대구 남구','대구 북구','대구 수성구','대구 달서구',
        '대전 동구','대전 중구','대전 서구','대전 유성구','대전 대덕구',
        '광주 동구','광주 서구','광주 남구','광주 북구','광주 광산구',
        '울산 중구','울산 남구','울산 동구','울산 북구','울산 울주군',
        '세종시','제주시','서귀포시',
        '충북 청주시','충북 충주시','충북 제천시',
        '충남 천안시','충남 공주시','충남 아산시','충남 서산시','충남 논산시',
        '전북 전주시','전북 군산시','전북 익산시','전북 정읍시',
        '전남 목포시','전남 여수시','전남 순천시','전남 나주시','전남 광양시',
        '경북 포항시','경북 경주시','경북 김천시','경북 안동시','경북 구미시',
        '경남 창원시','경남 진주시','경남 김해시','경남 거제시','경남 양산시',
        '강원 춘천시','강원 원주시','강원 강릉시','강원 동해시','강원 속초시',
      ];
      const filtered = REGIONS.filter(r =>
        r.replace(/ /g,'').includes(q.replace(/ /g,''))
      ).slice(0, 10).map(r => ({ name: r, address: r, category: '행정구역' }));
      sendJSON(res, { items: filtered, source: 'offline' });
    }
    return;
  }

  res.writeHead(404); res.end('not found');
});

const PORT = process.env.PORT || 3030;
initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚗 차량업무일지 서버 실행 중`);
    console.log(`📍 로컬: http://localhost:${PORT}`);
    console.log(`📡 배포: Railway + MongoDB Atlas\n`);
  });
});
