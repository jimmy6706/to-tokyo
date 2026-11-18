import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const core = dirname(fileURLToPath(import.meta.url));
const members = {pilgyu:'필규', inhye:'인혜', yuseon:'유선'};
const owner = 'pilgyu';
const outfits = new Set(['base','sprout','chiikawa','hachiware','usagi']);
const categories = new Set(['personal','shared','todo']);
const itemVisibleTo = (item, member) => item.kind !== 'personal' || item.author === member;
const dayIds = new Set(['16','17','18','19','20']);
const seedIds = new Set(['yoko-dinner','airbnb-store','saturday-option','shopping-time']);
const dayMs = 86400000;
const cookieName = 'tokyo_trip_session';
const digest = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const isRoomKey = value => /^[A-Za-z0-9_-]{43}$/.test(value);
const guestHtml = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>도쿄·요코하마 여행</title><style>body{background:#f7f3e9;color:#20283a;font:16px/1.5 system-ui;margin:0}main{max-width:28em;margin:12vh auto;padding:22px}label{display:block}input,button{font:inherit;min-height:44px;box-sizing:border-box}input{width:100%;margin:6px 0 8px}button{background:#263f75;color:white;border:0;border-radius:6px;padding:6px 18px}</style>
<main><h1>도쿄·요코하마 여행</h1><p>일행에게 받은 초대 링크로 들어오세요.</p>
<form id="trip-join"><label>초대 코드<input name="code" required autocomplete="off" maxlength="43"></label><button>참여하기</button></form>
<p id="trip-join-message" role="status"></p></main><script src="/stage2.js" defer></script>`;

class Failure extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const deny = (message = '일행에게만 허용된 기능이에요.') => { throw new Failure(403,message); };
const invalid = (message = '입력 내용을 확인해 주세요.') => { throw new Failure(400,message); };
const conflict = () => { throw new Failure(409,'다른 기기에서 먼저 수정했어요. 최신 내용을 보고 다시 저장해 주세요.'); };
function line(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) invalid();
  return value.trim();
}
function id(value) {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(value)) invalid();
  return value;
}
function visitId(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || !/^(16|17|18|19|20)\/[a-z0-9-]{1,65}$/i.test(value)) invalid();
  return value;
}
function externalUrl(value) {
  let url;
  try { url = new URL(line(value,2048,true)); } catch { invalid('올바른 링크 주소를 입력해 주세요.'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) invalid('http 또는 https 링크를 입력해 주세요.');
  return url.href;
}

export function createStore(path) {
  if (path !== ':memory:') {
    mkdirSync(dirname(resolve(path)), {recursive:true,mode:0o700});
  }
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path,0o600);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS records(scope TEXT, id TEXT, data TEXT NOT NULL, PRIMARY KEY(scope,id));
    CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, kind TEXT, member TEXT, day TEXT, visit TEXT,
      expires INTEGER NOT NULL, used INTEGER, revoked INTEGER);
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, member TEXT, invite TEXT, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS requests(member TEXT, id TEXT, data TEXT NOT NULL, PRIMARY KEY(member,id));
    CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    INSERT OR IGNORE INTO metadata VALUES('version',1);`);
  const statements = {
    read:db.prepare('SELECT data FROM records WHERE scope=? AND id=?'),
    list:db.prepare('SELECT data FROM records WHERE scope=? ORDER BY rowid'),
    write:db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET data=excluded.data'),
    invite:db.prepare('INSERT INTO invites(id,hash,kind,member,day,visit,expires) VALUES(?,?,?,?,?,?,?)'),
    inviteByHash:db.prepare('SELECT * FROM invites WHERE hash=?'),
    inviteById:db.prepare('SELECT * FROM invites WHERE id=?'),
    use:db.prepare('UPDATE invites SET used=? WHERE id=?'),
    revoke:db.prepare('UPDATE invites SET revoked=? WHERE id=?'),
    addSession:db.prepare('INSERT INTO sessions VALUES(?,?,?,?)'),
    session:db.prepare('SELECT * FROM sessions WHERE hash=? AND expires>?'),
    logout:db.prepare('DELETE FROM sessions WHERE hash=?'),
    request:db.prepare('SELECT data FROM requests WHERE member=? AND id=?'),
    saveRequest:db.prepare('INSERT INTO requests VALUES(?,?,?)'),
    version:db.prepare("SELECT value FROM metadata WHERE key='version'"),
    seeded:db.prepare("SELECT 1 FROM metadata WHERE key='seeded'"),
    bump:db.prepare("UPDATE metadata SET value=value+1 WHERE key='version'"),
    pending:db.prepare("SELECT id, member, expires FROM invites WHERE kind='member' AND used IS NULL AND revoked IS NULL AND expires>? ORDER BY expires DESC")
  };
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const read = (scope,key) => JSON.parse(statements.read.get(scope,key)?.data || 'null');
  const list = scope => statements.list.all(scope).map(row => JSON.parse(row.data)).filter(row => !row.deleted);
  const write = (scope,key,data) => { statements.write.run(scope,key,JSON.stringify(data)); };
  transaction(() => {
    // The first saved response still identifies the creator even if somebody else later edited the item.
    const migrated = db.prepare(`UPDATE records
      SET data = json_set(data, '$.author', COALESCE(
        (SELECT member FROM requests
         WHERE json_extract(requests.data, '$.id') = records.id
           AND json_extract(requests.data, '$.kind') = 'personal'
           AND json_extract(requests.data, '$.rev') = 1),
        json_extract(data, '$.by')
      ))
      WHERE scope = 'item' AND json_extract(data, '$.kind') = 'personal'
        AND json_extract(data, '$.author') IS NULL`).run();
    if (migrated.changes) statements.bump.run();
  });
  function issue(kind, member = '', day = '', visit = '') {
    const code = token();
    const key = randomUUID();
    const expires = Date.now() + (kind === 'member' ? 3 : 7) * dayMs;
    statements.invite.run(key,digest(code),kind,member,day,visit,expires);
    return {id:key,code,expires};
  }
  function joinInvite(code, existing) {
    if (typeof code !== 'string' || !/^[\w-]{43}$/.test(code)) invalid('초대 코드를 확인해 주세요.');
    return transaction(() => {
      const invitation = statements.inviteByHash.get(digest(code));
      const now = Date.now();
      if (!invitation || invitation.revoked || invitation.expires <= now || invitation.used) {
        throw new Failure(410,'만료되었거나 사용된 링크예요. 일행에게 새 링크를 받아 주세요.');
      }
      if (invitation.kind === 'viewer' && existing?.role === 'member') {
        return {day:invitation.day,visit:invitation.visit,kind:invitation.kind};
      }
      if (invitation.kind === 'member') statements.use.run(now,invitation.id);
      const session = token();
      const expiry = invitation.kind === 'member' ? now + 90 * dayMs : invitation.expires;
      statements.addSession.run(digest(session),invitation.member,invitation.id,expiry);
      statements.bump.run();
      return {session,expiry,day:invitation.day,visit:invitation.visit,kind:invitation.kind};
    });
  }
  function authenticate(raw) {
    if (!/^[\w-]{43}$/.test(raw || '')) return null;
    const session = statements.session.get(digest(raw),Date.now());
    if (!session) return null;
    if (session.member) return {role:'member',id:session.member,isOwner:session.member === owner};
    const invite = statements.inviteById.get(session.invite);
    if (!invite || invite.revoked || invite.expires <= Date.now()) return null;
    return {role:'viewer', day:invite.day, visit:invite.visit};
  }
  function state(auth) {
    const version = statements.version.get().value;
    const notes = list('note');
    const guides = list('guide');
    if (auth.role === 'viewer') {
      const visible = notes.filter(note => auth.visit ? note.place === auth.visit.split('.')[0] && (!note.visit || note.visit === auth.visit.split('.')[1])
        : note.days.includes(auth.day) && (!note.visit || note.visit.startsWith(auth.day + '/')));
      const visibleGuides = guides.filter(guide => auth.visit ? guide.id === auth.visit.split('.')[1] : guide.id.startsWith(auth.day + '/'));
      return {version, auth, notes:visible, guides:visibleGuides, people:members};
    }
    const items = list('item').filter(item => itemVisibleTo(item,auth.id));
    const visibleItems = new Set(items.map(item => item.id));
    const checks = list('check').filter(check => visibleItems.has(check.item) && (!check.person || check.person === auth.id));
    return {version,auth,seeded:!!statements.seeded.get(),people:members,notes,guides,items,checks,links:list('link'),outfits:list('outfit'),
      invitations:auth.isOwner ? statements.pending.all(Date.now()) : []};
  }
  function mutate(auth, payload) {
    if (auth.role !== 'member') deny('읽기 전용 링크에서는 편집할 수 없어요.');
    const member = auth.id;
    if (typeof payload.requestId !== 'string' || !/^[\da-f-]{36}$/i.test(payload.requestId)) invalid();
    const op = line(payload.op,25,true);
    return transaction(() => {
      const duplicate = statements.request.get(member,payload.requestId);
      if (duplicate) {
        const result = JSON.parse(duplicate.data);
        const itemId = categories.has(result.kind) ? result.id : result.item;
        const item = itemId && read('item',itemId);
        if (item) requireVisibleItem(item);
        return result;
      }
      const now = new Date().toISOString();
      const result = change();
      statements.saveRequest.run(member,payload.requestId,JSON.stringify(result));
      statements.bump.run();
      return result;

      function requireVisibleItem(item) {
        if (!itemVisibleTo(item,member)) throw new Failure(404,'항목을 찾을 수 없어요.');
      }
      function revision(scope,key, allowDeleted = false) {
        const row = read(scope,id(key));
        if (!row || (row.deleted && !allowDeleted)) throw new Failure(404,'이미 삭제되었어요.');
        if (scope === 'item') requireVisibleItem(row);
        if (payload.rev !== row.rev) conflict();
        return row;
      }
      function record(scope, data, old) {
        const row = {...old,...data,id:old?.id || randomUUID(),rev:(old?.rev || 0) + 1, by:member,updated:now};
        write(scope,row.id,row);
        return row;
      }
      function change() {
        if (op === 'seed') {
          const seen = statements.seeded.get();
          if (seen) return {};
          if (!Array.isArray(payload.items) || payload.items.length !== seedIds.size) invalid();
          const keys = new Set();
          for (const item of payload.items) {
            if (!seedIds.has(item.id) || keys.has(item.id)) invalid();
            keys.add(item.id);
            const key = 'legacy-' + item.id;
            write('item',key,{id:key, kind:'todo',title:line(item.title,120,true),detail:line(item.detail,600),
              stage:line(item.stage,20), qty:1, assignee:'', by:'',updated:now,rev:1});
          }
          db.prepare("INSERT INTO metadata VALUES('seeded',1)").run();
          return {};
        }
        if (op === 'item') {
          const old = payload.id ? revision('item',payload.id) : null;
          const kind = old?.kind || payload.kind;
          if (!categories.has(kind)) invalid();
          const assignee = kind === 'personal' ? '' : line(payload.assignee,15);
          if (assignee && !Object.hasOwn(members,assignee)) invalid();
          const qty = kind === 'shared' ? payload.qty : 1;
          if (!Number.isInteger(qty) || qty < 1 || qty > 999) invalid('수량은 1~999개로 입력해 주세요.');
          const data = {kind,assignee,qty,title:line(payload.title,120,true),detail:line(payload.detail,600)};
          if (kind === 'personal') data.author = member;
          return record('item',data,old);
        }
        if (op === 'check') {
          const item = read('item',id(payload.id));
          if (!item || item.deleted) throw new Failure(404,'이미 삭제된 항목이에요.');
          requireVisibleItem(item);
          if (typeof payload.done !== 'boolean') invalid();
          const person = item.kind === 'personal' ? member : '';
          const key = item.id + ':' + person;
          const previous = read('check',key);
          if ((previous?.rev || 0) !== payload.rev) conflict();
          const checked = {id:key, item:item.id,person,done:payload.done,by:member,updated:now,rev:payload.rev + 1};
          write('check',key,checked);
          return checked;
        }
        if (op === 'guide') {
          const visit = visitId(payload.visit);
          if (!visit) invalid();
          const previous = read('guide',visit);
          if (payload.rev !== (previous?.rev || 0)) conflict();
          // Keep an empty override so a removed itinerary note stays removed on future visits.
          const guide = {id:visit, text:line(payload.text,800),rev:payload.rev + 1,by:member,updated:now};
          write('guide',visit,guide);
          return guide;
        }
        if (op === 'note') {
          const old = payload.id ? revision('note',payload.id) : null;
          if (old && old.author !== member) deny('작성자만 메모를 수정할 수 있어요.');
          if (!old && (!Array.isArray(payload.days) || payload.days.length > 5 || !payload.days.every(day => dayIds.has(day)))) invalid();
          return record('note',{author:member,created:old?.created || now, place:old?.place || id(payload.place),
            days:old?.days || payload.days, visit:old?.visit ?? visitId(payload.visit), text:line(payload.text,800,true),
            suggestion:payload.suggestion === true,pinned:payload.pinned === true},old);
        }
        if (op === 'link') {
          const old = payload.id ? revision('link',payload.id) : null;
          return record('link',{title:line(payload.title,120,true),url:externalUrl(payload.url)},old);
        }
        if (op === 'remove' || op === 'restore') {
          const scope = payload.scope;
          if (!['item','note','link'].includes(scope)) invalid();
          const old = revision(scope,payload.id,op === 'restore');
          if (scope === 'note' && old.author !== member) deny();
          if (op === 'restore' && (!old.deleted || old.by !== member)) deny();
          return record(scope,{deleted:op === 'remove'},old);
        }
        if (op === 'outfit') {
          if (!outfits.has(payload.outfit)) invalid();
          write('outfit',member,{id:member,outfit:payload.outfit,updated:now});
          return {};
        }
        if (op === 'invite') {
          if (payload.kind === 'member') {
            if (!auth.isOwner || !Object.hasOwn(members,payload.member)) deny();
            return issue('member',payload.member);
          }
          if (payload.kind !== 'viewer' || !dayIds.has(payload.day)) invalid();
          let visit = '';
          if (payload.visit) {
            const key = visitId(payload.visit);
            if (!key.startsWith(payload.day + '/')) invalid();
            visit = id(payload.place) + '.' + key;
          }
          return issue('viewer','',payload.day,visit);
        }
        if (op === 'revoke') {
          if (!auth.isOwner) deny();
          const invite = statements.inviteById.get(id(payload.id));
          if (!invite || invite.used || invite.revoked || invite.kind !== 'member') invalid();
          statements.revoke.run(Date.now(),invite.id);
          return {};
        }
        invalid();
      }
    });
  }
  return {issue,joinInvite,authenticate,state,mutate,profileOutfits:() => list('outfit').map(({id,outfit}) => ({id,outfit})),logout:raw=>statements.logout.run(digest(raw || '')),db};
}

export function createTripServer({database, origin = '', pagesUrl = '', roomKey = ''}) {
  if (Boolean(pagesUrl) !== Boolean(roomKey) || (roomKey && !isRoomKey(roomKey))) {
    throw new Error('Set TRIP_PAGES_URL and a 32-byte base64url TRIP_ROOM_KEY together.');
  }
  const pagesOrigin = pagesUrl ? new URL(pagesUrl).origin : '';
  const roomDigest = roomKey ? Buffer.from(digest(roomKey), 'hex') : null;
  const store = createStore(database);
  const html = readFileSync(join(core,'index.html'),'utf8').replace('<body>', '<body data-trip-server="member">');
  const viewerHtml = html.replace('data-trip-server="member"','data-trip-server="viewer"').replaceAll(/birth:'[\d-]+'/g,"birth:''")
    .replace(/airbnb:'[^']+'/, "airbnb:'JR 田端駅 南口'");
  const assets = new Map([
    ['/stage2.js',[readFileSync(join(core,'stage2.js')),'text/javascript; charset=utf-8']],
    ['/stage2.css',[readFileSync(join(core,'stage2.css')),'text/css; charset=utf-8']]
  ]);
  const server = createServer(async (req,res) => {
    const port = server.address().port;
    const origins = origin ? [origin] : ['http://127.0.0.1:' + port,'http://localhost:' + port];
    const host = req.headers.host || '';
    const localOrigin = origins.find(value => new URL(value).host === host);
    if (!localOrigin) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    const url = new URL(req.url,localOrigin);
    const roomRoute = ['/api/state','/api/action','/api/profiles'].includes(url.pathname);
    const requestOrigin = req.headers.origin;
    const pagesRequest = Boolean(pagesOrigin && roomRoute && requestOrigin === pagesOrigin);
    if (pagesOrigin && roomRoute) res.setHeader('Vary', 'Origin');
    if (pagesRequest) {
      res.setHeader('Access-Control-Allow-Origin', pagesOrigin);
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');
        return res.writeHead(204).end();
      }
    }
    const cookie = req.headers.cookie?.match(new RegExp('(?:^|; *)' + cookieName + '=([\\w-]+)'))?.[1];
    let auth;
    if (pagesRequest) {
      const credentials = /^Bearer ([a-z]+)\.([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
      if (credentials && Object.hasOwn(members, credentials[1]) &&
          timingSafeEqual(Buffer.from(digest(credentials[2]), 'hex'), roomDigest)) {
        auth = {role:'member', id:credentials[1], isOwner:false};
      }
    } else {
      auth = store.authenticate(cookie);
    }
    function send(status,data,type = 'application/json; charset=utf-8') {
      res.writeHead(status,{'content-type':type});
      res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
    }
    function setSession(value, expires) {
      res.setHeader('Set-Cookie',cookieName + '=' + value + '; Path=/; HttpOnly; SameSite=Strict; Expires=' +
        new Date(expires).toUTCString() + (localOrigin.startsWith('https:') ? '; Secure' : ''));
    }
    try {
      if (req.method === 'GET') {
        if (assets.has(url.pathname)) {
          const [data,type] = assets.get(url.pathname);
          return send(200,data,type);
        }
        if (url.pathname === '/api/profiles') {
          const key = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
          if (!pagesRequest || !key || !timingSafeEqual(Buffer.from(digest(key),'hex'),roomDigest)) deny();
          return send(200,store.profileOutfits());
        }
        if (url.pathname === '/api/state') {
          if (!auth) return send(401,{error:pagesRequest ? '일행에게 받은 공동 편집 링크를 다시 열어 주세요.' : '초대 링크로 들어와 주세요.'});
          const snapshot = store.state(auth);
          if (url.searchParams.get('since') === String(snapshot.version)) return res.writeHead(204).end();
          return send(200,snapshot);
        }
        if (['/','/index.html'].includes(url.pathname)) {
          const page = !auth ? guestHtml : auth.role === 'viewer' ? viewerHtml : html;
          return send(200,page,'text/html; charset=utf-8');
        }
      }
      if (req.method === 'POST' && ['/api/join','/api/action','/api/logout'].includes(url.pathname)) {
        if ((!pagesRequest && requestOrigin !== localOrigin) || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) deny('현재 여행 페이지에서 다시 시도해 주세요.');
        const chunks = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 24000) throw new Failure(413,'입력 내용이 너무 길어요.');
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { invalid(); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
        if (url.pathname === '/api/join') {
          const joined = store.joinInvite(body.code,auth);
          if (joined.session) setSession(joined.session,joined.expiry);
          return send(200,{day:joined.day,visit:joined.visit,role:joined.kind});
        }
        if (!auth) return send(401,{error:pagesRequest ? '일행에게 받은 공동 편집 링크를 다시 열어 주세요.' : '세션이 끝났어요. 초대 링크로 다시 들어와 주세요.'});
        if (url.pathname === '/api/logout') {
          store.logout(cookie);
          setSession('',0);
          return send(200,{});
        }
        if (pagesRequest && body.op === 'invite') deny();
        return send(200,store.mutate(auth,body));
      }
      send(404,{error:'주소를 찾지 못했어요.'});
    } catch (error) {
      if (!(error instanceof Failure)) console.error(error.message);
      if (!res.headersSent && !res.destroyed) send(error.status || 500,{error:error.status ? error.message : '저장 중 문제가 생겼어요. 다시 시도해 주세요.'});
    }
  });
  return {server,store};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const database = process.env.TRIP_DB || join(core,'.trip-data','trip.sqlite');
  const port = Number(process.env.PORT || 8787);
  const origin = process.env.TRIP_ORIGIN || '';
  const pagesUrl = process.env.TRIP_PAGES_URL || '';
  const roomKey = process.env.TRIP_ROOM_KEY || '';
  if (origin && (new URL(origin).origin !== origin || !origin.startsWith('https://'))) {
    throw new Error('TRIP_ORIGIN must be an HTTPS origin.');
  }
  if (pagesUrl) {
    const pages = new URL(pagesUrl);
    if (pages.protocol !== 'https:' || pages.username || pages.password || pages.hash || pages.search) {
      throw new Error('TRIP_PAGES_URL must be the HTTPS address of the GitHub Pages trip page.');
    }
  }
  if (process.argv[2] === 'room-link') {
    if (!origin || !pagesUrl || !isRoomKey(roomKey)) {
      throw new Error('Set TRIP_ORIGIN, TRIP_PAGES_URL and TRIP_ROOM_KEY to generate the group link.');
    }
    const link = new URL(pagesUrl);
    link.hash = new URLSearchParams({room:roomKey, api:origin});
    console.log(link.href);
  } else if (process.argv[2] === 'invite-owner') {
    const store = createStore(database);
    const invitation = store.issue('member',owner);
    console.log((origin || 'http://127.0.0.1:' + port) + '/#join=' + invitation.code);
    store.db.close();
  } else {
    const {server} = createTripServer({database,origin,pagesUrl,roomKey});
    server.listen(port, process.env.TRIP_HOST || '127.0.0.1', () => {
      console.log('Travel app · ' + (origin || 'http://127.0.0.1:' + server.address().port));
    });
  }
}
