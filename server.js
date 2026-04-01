const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ── 버전 정보 ──
const VERSION = '2.0.0';

// ── DB: MongoDB Atlas 또는 로컬 파일 자동 전환 ──
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234'; // 기본 PIN (환경변수로 변경 권장)
const DB_FILE = path.join(__dirname, 'db.json');

let db = { employees: [], records: [], presets: {}, vehicles: [], odometerRecords: [] };
let mongoCol = null;
let isSaving = false; // 동시 저장 방지

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
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE));
      if (!db.presets)          db.presets          = {};
      if (!db.employees)        db.employees        = [];
      if (!db.records)          db.records          = [];
      if (!db.vehicles)         db.vehicles         = [];
      if (!db.odometerRecords)  db.odometerRecords  = [];
    } catch(e) {
      console.error('db.json 파싱 오류, 빈 DB로 시작:', e.message);
    }
  }
}

// ── 저장 (동시 저장 방지) ──
async function saveDB() {
  if (isSaving) {
    // 대기 후 재시도
    await new Promise(r => setTimeout(r, 50));
    return saveDB();
  }
  isSaving = true;
  try {
    if (mongoCol) {
      await mongoCol.replaceOne({ _id: 'main' }, { _id: 'main', ...db }, { upsert: true });
    } else {
      // 원자적 쓰기: 임시 파일 → 이름 변경
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, DB_FILE);
    }
  } finally {
    isSaving = false;
  }
}

// ── HTTP 서버 ──
function readBody(req, cb) {
  let b = '';
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > 5 * 1024 * 1024) { // 5MB 제한
      req.destroy();
      return;
    }
    b += c;
  });
  req.on('end', () => {
    try { cb(JSON.parse(b || '{}')); }
    catch(e) { cb({}); }
  });
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

  const { pathname } = url.parse(req.url, true);
  const m = req.method;

  // ── HTML 서빙 ──
  if (m === 'GET' && pathname === '/') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    } catch(e) { res.writeHead(500); res.end('index.html not found'); }
    return;
  }

  // ── GET /api/data ──
  if (m === 'GET' && pathname === '/api/data') {
    sendJSON(res, db); return;
  }

  // ── GET /api/version ──
  if (m === 'GET' && pathname === '/api/version') {
    sendJSON(res, { version: VERSION }); return;
  }

  // ── GET /api/export (전체 데이터 백업) ──
  if (m === 'GET' && pathname === '/api/export') {
    const exportData = {
      version: VERSION,
      exportedAt: new Date().toISOString(),
      ...db
    };
    res.writeHead(200, {
      'Content-Type': 'application/json;charset=utf-8',
      'Content-Disposition': `attachment; filename="backup_${new Date().toISOString().slice(0,10)}.json"`,
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(exportData, null, 2));
    console.log('[백업] 전체 데이터 내보내기');
    return;
  }

  // ── POST /api/import (데이터 복원) ──
  if (m === 'POST' && pathname === '/api/import') {
    readBody(req, async b => {
      if (!b.employees || !b.records) {
        return sendJSON(res, { ok: false, msg: '올바른 백업 파일이 아닙니다' });
      }
      db = { employees: b.employees||[], records: b.records||[], presets: b.presets||{} };
      await saveDB();
      console.log('[복원] 데이터 복원 완료');
      sendJSON(res, { ok: true, msg: '복원 완료', data: db });
    }); return;
  }

  // ── POST /api/verify-pin (PIN 검증) ──
  if (m === 'POST' && pathname === '/api/verify-pin') {
    readBody(req, b => {
      const ok = b.pin === ADMIN_PIN;
      sendJSON(res, { ok });
    }); return;
  }

  // ── POST /api/employee ──
  if (m === 'POST' && pathname === '/api/employee') {
    readBody(req, async b => {
      const name = (b.name || '').trim();
      if (!name) return sendJSON(res, { ok: false, msg: '이름을 입력해주세요' });
      if (name.length > 20) return sendJSON(res, { ok: false, msg: '이름이 너무 깁니다 (최대 20자)' });
      if (db.employees.includes(name)) return sendJSON(res, { ok: false, msg: '이미 등록된 사원입니다' });
      db.employees.push(name);
      await saveDB();
      console.log(`[사원추가] ${name}`);
      sendJSON(res, { ok: true, data: db });
    }); return;
  }

  // ── DELETE /api/employee/:name (기록/프리셋도 함께 삭제) ──
  if (m === 'DELETE' && pathname.startsWith('/api/employee/')) {
    readBody(req, async b => {
      const name = decodeURIComponent(pathname.replace('/api/employee/', ''));
      const recordCount = db.records.filter(r => r.emp === name).length;

      // [버그수정] 직원의 기록과 프리셋도 함께 삭제
      db.employees = db.employees.filter(e => e !== name);
      db.records   = db.records.filter(r => r.emp !== name);
      delete db.presets[name];

      await saveDB();
      console.log(`[사원삭제] ${name} (기록 ${recordCount}건 함께 삭제)`);
      sendJSON(res, { ok: true, data: db, deletedRecords: recordCount });
    }); return;
  }

  // ── POST /api/preset ──
  if (m === 'POST' && pathname === '/api/preset') {
    readBody(req, async b => {
      if (!b.emp) return sendJSON(res, { ok: false, msg: '사원 정보 없음' });
      db.presets[b.emp] = b;
      await saveDB();
      sendJSON(res, { ok: true });
    }); return;
  }

  // ── POST /api/record ──
  if (m === 'POST' && pathname === '/api/record') {
    readBody(req, async b => {
      if (!b.emp || !b.date) return sendJSON(res, { ok: false, msg: '필수 항목 누락' });
      if (!db.employees.includes(b.emp)) return sendJSON(res, { ok: false, msg: '등록되지 않은 사원입니다' });

      b.id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      b.createdAt = new Date().toISOString();
      db.records.push(b);
      await saveDB();
      console.log(`[기록추가] ${b.emp} / ${b.date} / ${b.type} / 출근:${b.checkin_time||'-'} 퇴근:${b.checkout_time||'-'}`);
      sendJSON(res, { ok: true, data: db });
    }); return;
  }

  // ── POST /api/records/bulk (자동입력 - 여러 기록 한번에 저장) ──
  if (m === 'POST' && pathname === '/api/records/bulk') {
    readBody(req, async b => {
      const records = b.records;
      if (!Array.isArray(records) || !records.length) {
        return sendJSON(res, { ok: false, msg: '기록 배열이 비어있습니다' });
      }
      let added = 0;
      for (const r of records) {
        if (!r.emp || !r.date) continue;
        if (!db.employees.includes(r.emp)) continue;
        // 중복 방지: 같은 emp+date+type+direction 이미 있으면 스킵
        const dup = db.records.some(x =>
          x.emp === r.emp && x.date === r.date &&
          x.type === r.type && (x.direction||'') === (r.direction||'')
        );
        if (dup) continue;
        r.id = Date.now() + '_' + Math.random().toString(36).slice(2,6) + '_' + added;
        r.createdAt = new Date().toISOString();
        db.records.push(r);
        added++;
      }
      await saveDB();
      console.log(`[자동입력] ${added}건 추가됨`);
      sendJSON(res, { ok: true, added, data: db });
    }); return;
  }

  // ── PATCH /api/record/:id (퇴근 시각 업데이트) ──
  if (m === 'PATCH' && pathname.startsWith('/api/record/')) {
    const id = pathname.replace('/api/record/', '');
    readBody(req, async b => {
      const rec = db.records.find(r => r.id === id);
      if (!rec) return sendJSON(res, { ok: false, msg: '기록을 찾을 수 없습니다' });
      // 업데이트 허용 필드 (퇴근 시각, 메모, 주행거리)
      if (b.checkout_time !== undefined) rec.checkout_time = b.checkout_time;
      if (b.memo !== undefined)          rec.memo          = b.memo;
      if (b.km !== undefined)            rec.km            = Number(b.km) || 0;
      rec.updatedAt = new Date().toISOString();
      await saveDB();
      console.log(`[기록수정] ${rec.emp} / ${rec.date} / 퇴근:${rec.checkout_time||'-'}`);
      sendJSON(res, { ok: true, data: db });
    }); return;
  }

  // ── DELETE /api/record/:id ──
  if (m === 'DELETE' && pathname.startsWith('/api/record/')) {
    const id = pathname.replace('/api/record/', '');
    db.records = db.records.filter(r => r.id !== id);
    saveDB().then(() => sendJSON(res, { ok: true, data: db }));
    return;
  }

  // ── POST /api/vehicle ──
  if (m === 'POST' && pathname === '/api/vehicle') {
    readBody(req, async b => {
      const plate = (b.plate || '').trim();
      const model = (b.model || '').trim();
      const year  = Number(b.year) || new Date().getFullYear();
      if (!plate) return sendJSON(res, { ok: false, msg: '번호판을 입력해주세요' });
      if (db.vehicles.find(v => v.plate === plate)) {
        return sendJSON(res, { ok: false, msg: '이미 등록된 번호판입니다' });
      }
      const vehicle = { id: 'v_' + Date.now(), plate, model, year };
      db.vehicles.push(vehicle);
      await saveDB();
      console.log(`[차량추가] ${plate} / ${model} / ${year}`);
      sendJSON(res, { ok: true, data: db });
    }); return;
  }

  // ── DELETE /api/vehicle/:id ──
  if (m === 'DELETE' && pathname.startsWith('/api/vehicle/')) {
    const id = pathname.replace('/api/vehicle/', '');
    db.vehicles = db.vehicles.filter(v => v.id !== id);
    db.odometerRecords = db.odometerRecords.filter(o => o.vehicleId !== id);
    console.log(`[차량삭제] id:${id}`);
    saveDB().then(() => sendJSON(res, { ok: true, data: db }));
    return;
  }

  // ── POST /api/odometer (월 계기판 저장/수정) ──
  if (m === 'POST' && pathname === '/api/odometer') {
    readBody(req, async b => {
      const { vehicleId, year, month, startKm, endKm } = b;
      if (!vehicleId || !year || !month) return sendJSON(res, { ok: false, msg: '필수 항목 누락' });
      if (!db.vehicles.find(v => v.id === vehicleId)) {
        return sendJSON(res, { ok: false, msg: '등록되지 않은 차량입니다' });
      }
      // 같은 차량+년+월 레코드가 있으면 업데이트, 없으면 추가
      let rec = db.odometerRecords.find(o => o.vehicleId === vehicleId && o.year == year && o.month == month);
      if (rec) {
        rec.startKm = Number(startKm) || 0;
        rec.endKm   = Number(endKm)   || 0;
        rec.updatedAt = new Date().toISOString();
      } else {
        rec = {
          id: 'o_' + Date.now(),
          vehicleId,
          year: Number(year), month: Number(month),
          startKm: Number(startKm) || 0,
          endKm:   Number(endKm)   || 0,
          createdAt: new Date().toISOString()
        };
        db.odometerRecords.push(rec);
      }
      await saveDB();
      console.log(`[계기판] 차량:${vehicleId} / ${year}-${month} / ${startKm}→${endKm}km`);
      sendJSON(res, { ok: true, data: db });
    }); return;
  }

  // ── DELETE /api/odometer/:id ──
  if (m === 'DELETE' && pathname.startsWith('/api/odometer/')) {
    const id = pathname.replace('/api/odometer/', '');
    db.odometerRecords = db.odometerRecords.filter(o => o.id !== id);
    saveDB().then(() => sendJSON(res, { ok: true, data: db }));
    return;
  }

  res.writeHead(404); res.end('not found');
});

const PORT = process.env.PORT || 3030;
initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚗 차량업무일지 v${VERSION} 서버 실행 중`);
    console.log(`📍 로컬: http://localhost:${PORT}`);
    console.log(`📡 배포: Railway + MongoDB Atlas`);
    console.log(`🔒 관리자 PIN: ${MONGO_URI ? '(환경변수에서 로드)' : ADMIN_PIN}`);
    console.log(`   ※ 보안을 위해 ADMIN_PIN 환경변수를 설정하세요\n`);
  });
});
