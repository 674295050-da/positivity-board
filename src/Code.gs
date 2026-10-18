/**
 * Positivity Board - Backend (Google Apps Script)
 * Deploy: Execute as "Me", Who has access "Anyone"
 *
 * Script Properties ที่ต้องตั้ง:
 *   GEMINI_API_KEY      key ของ Gemini
 *   OAUTH_CLIENT_ID     จาก Google Cloud Console (OAuth client แบบ Web application)
 *   OAUTH_CLIENT_SECRET จาก Google Cloud Console
 *   ADMIN_EMAILS        อีเมลแอดมิน คั่นด้วย , เช่น a@gmail.com,b@gmail.com
 *   APP_URL             Web app URL (ลงท้าย /exec) ต้องตรงกับ Redirect URI ใน OAuth client
 *   SESSION_SECRET      สร้างอัตโนมัติโดยรัน setupSessionSecret() หนึ่งครั้ง
 */

const SHEET_NAME = 'Sheet1';
const LIKES_SHEET = 'Likes';
const GEMINI_MODEL = 'gemini-3.8-flash';
const MAX_NOTE_LENGTH = 500;
const MAX_TOWHO_LENGTH = 40;
const MAX_CHAT_LENGTH = 500;
const SESSION_HOURS = 24 * 7;
const LOGIN_REQUIRED = { success: false, error: 'LOGIN_REQUIRED' };
const BANNED_MSG = { success: false, error: 'บัญชีของคุณถูกระงับการใช้งานโดยแอดมิน' };
const BANS_SHEET = 'Bans';
const REPORTS_SHEET = 'Reports';

const ALLOWED_COLORS = [
  'bg-amber-100', 'bg-rose-100', 'bg-sky-100', 'bg-emerald-100', 'bg-purple-100',
  'bg-orange-100', 'bg-teal-100', 'bg-indigo-100', 'bg-fuchsia-100', 'bg-slate-200'
];

/* ---------- helpers ---------- */
function prop_(k) { return String(PropertiesService.getScriptProperties().getProperty(k) || '').trim(); }
function appUrl_() { return prop_('APP_URL') || ScriptApp.getService().getUrl(); }
function now_() { return Utilities.formatDate(new Date(), 'GMT+7', 'dd/MM/yyyy HH:mm:ss'); }
function pad_(s) { return s + '='.repeat((4 - (s.length % 4)) % 4); }
function decodeB64_(s) { return Utilities.newBlob(Utilities.base64DecodeWebSafe(pad_(s))).getDataAsString(); }

function isAdmin_(email) {
  const list = prop_('ADMIN_EMAILS').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  return list.indexOf(String(email).toLowerCase()) !== -1;
}

// กัน Google Sheets ตีความข้อความที่ขึ้นต้นด้วย = + - @ เป็นสูตร
function safeCell_(text) {
  const s = String(text || '');
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function throttle_(key, seconds) {
  const c = CacheService.getScriptCache();
  if (c.get(key)) return false;
  c.put(key, '1', seconds);
  return true;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function getTargetSheet() {
  const doc = SpreadsheetApp.getActiveSpreadsheet();
  return doc.getSheetByName(SHEET_NAME) || doc.getSheets()[0];
}

function getLikesSheet_() {
  const doc = SpreadsheetApp.getActiveSpreadsheet();
  let s = doc.getSheetByName(LIKES_SHEET);
  if (!s) {
    s = doc.insertSheet(LIKES_SHEET);
    s.appendRow(['NoteID', 'Email', 'CreatedAt']);
  }
  return s;
}

function findRow_(sheet, id) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return 0;
}

/* ---------- แบน / รายงาน ---------- */
function getAuxSheet_(name, headers) {
  const doc = SpreadsheetApp.getActiveSpreadsheet();
  let s = doc.getSheetByName(name);
  if (!s) { s = doc.insertSheet(name); s.appendRow(headers); }
  return s;
}
function bansSheet_() { return getAuxSheet_(BANS_SHEET, ['Email', 'BannedAt', 'BannedBy']); }
function reportsSheet_() { return getAuxSheet_(REPORTS_SHEET, ['NoteID', 'Reporter', 'CreatedAt', 'Status']); }

function bannedList_() {
  const s = bansSheet_();
  if (s.getLastRow() < 2) return [];
  return s.getRange(2, 1, s.getLastRow() - 1, 2).getValues().map(function (r) {
    return { email: String(r[0]).toLowerCase(), bannedAt: String(r[1]) };
  });
}
function isBanned_(email) {
  const e = String(email).toLowerCase();
  return bannedList_().some(function (b) { return b.email === e; });
}
function adminGate_(token) {
  const me = getSession_(token);
  if (!me) return { fail: LOGIN_REQUIRED };
  if (!me.isAdmin) return { fail: { success: false, error: 'ต้องเป็นแอดมินเท่านั้น' } };
  return { me: me };
}
function setReportStatus_(id, status) {
  const s = reportsSheet_();
  const last = s.getLastRow();
  if (last < 2) return;
  const vals = s.getRange(2, 1, last - 1, 4).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === String(id) && vals[i][3] === 'open') s.getRange(i + 2, 4).setValue(status);
  }
}

/* ---------- session token (stateless, HMAC) ---------- */
function sign_(data) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(data, prop_('SESSION_SECRET')));
}

function makeToken_(user) {
  const body = Utilities.base64EncodeWebSafe(
    JSON.stringify({ email: user.email, name: user.name, exp: Date.now() + SESSION_HOURS * 3600 * 1000 }),
    Utilities.Charset.UTF_8
  );
  return body + '.' + sign_(body);
}

function getSession_(token) {
  try {
    if (!token || !prop_('SESSION_SECRET')) return null;
    const parts = String(token).split('.');
    if (parts.length !== 2 || parts[1] !== sign_(parts[0])) return null;
    const data = JSON.parse(decodeB64_(parts[0]));
    if (!data.exp || data.exp < Date.now()) return null;
    return { email: data.email, name: data.name, isAdmin: isAdmin_(data.email) };
  } catch (e) {
    return null;
  }
}

function setupSessionSecret() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('SESSION_SECRET')) {
    p.setProperty('SESSION_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }
  Logger.log('SESSION_SECRET พร้อมใช้งาน');
}

/* ---------- Google OAuth (authorization code flow) ---------- */
function loginUrl_() {
  const state = Utilities.getUuid();
  CacheService.getScriptCache().put('st_' + state, '1', 600);
  const q = {
    client_id: prop_('OAUTH_CLIENT_ID'),
    redirect_uri: appUrl_(),
    response_type: 'code',
    scope: 'openid email profile',
    state: state,
    prompt: 'select_account'
  };
  return 'https://accounts.google.com/o/oauth2/v2/auth?' +
    Object.keys(q).map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&');
}

function exchangeCode_(code) {
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: {
      code: code,
      client_id: prop_('OAUTH_CLIENT_ID'),
      client_secret: prop_('OAUTH_CLIENT_SECRET'),
      redirect_uri: appUrl_(),
      grant_type: 'authorization_code'
    },
    muteHttpExceptions: true
  });
  const json = JSON.parse(res.getContentText());
  if (!json.id_token) throw new Error(json.error_description || json.error || 'ไม่ได้รับ id_token');
  // id_token ได้รับตรงจาก Google ผ่าน HTTPS จึงใช้ payload ได้เลย
  const p = JSON.parse(decodeB64_(json.id_token.split('.')[1]));
  if (!p.email || p.email_verified === false) throw new Error('อีเมลยังไม่ได้รับการยืนยัน');
  return { email: p.email, name: p.name || p.email.split('@')[0] };
}

function doGet(e) {
  const missing = ['OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET', 'SESSION_SECRET'].filter(function (k) { return !prop_(k); });
  const boot = {
    token: '',
    error: '',
    loginUrl: '',
    missing: missing,
    configured: missing.length === 0
  };
  const p = (e && e.parameter) || {};

  if (p.code) {
    const cache = CacheService.getScriptCache();
    if (p.state && cache.get('st_' + p.state)) {
      cache.remove('st_' + p.state);
      try {
        boot.token = makeToken_(exchangeCode_(p.code));
      } catch (err) {
        boot.error = 'เข้าสู่ระบบไม่สำเร็จ: ' + err.message;
      }
    } else {
      boot.error = 'ลิงก์เข้าสู่ระบบหมดอายุ กรุณากดเข้าสู่ระบบใหม่';
    }
  } else if (p.error) {
    boot.error = 'ยกเลิกการเข้าสู่ระบบ';
  }
  if (boot.configured) boot.loginUrl = loginUrl_();

  const t = HtmlService.createTemplateFromFile('Index');
  t.boot = JSON.stringify(boot).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle('Positivity Board - บอร์ดส่งกำลังใจ')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ---------- API สำหรับหน้าเว็บ ---------- */
function getSessionInfo(token) {
  const me = getSession_(token);
  return me ? { loggedIn: true, name: me.name, email: me.email, isAdmin: me.isAdmin, banned: isBanned_(me.email) } : { loggedIn: false };
}

function getNotes(token) {
  const me = getSession_(token);
  const data = getTargetSheet().getDataRange().getValues();
  if (data.length <= 1) return [];

  const liked = {};
  if (me) {
    const ls = getLikesSheet_();
    if (ls.getLastRow() > 1) {
      ls.getRange(2, 1, ls.getLastRow() - 1, 2).getValues().forEach(function (v) {
        if (String(v[1]).toLowerCase() === me.email.toLowerCase()) liked[String(v[0])] = true;
      });
    }
  }

  const reported = {};
  if (me) {
    const rs = reportsSheet_();
    if (rs.getLastRow() > 1) {
      rs.getRange(2, 1, rs.getLastRow() - 1, 2).getValues().forEach(function (v) {
        if (String(v[1]).toLowerCase() === me.email.toLowerCase()) reported[String(v[0])] = true;
      });
    }
  }

  return data.slice(1)
    .map(function (r) {
      const author = String(r[7] || '').toLowerCase();
      return {
        id: String(r[0] || ''),
        toWho: String(r[1] || 'ถึงทุกคน'),
        message: String(r[2] || ''),
        bgColor: String(r[3] || 'bg-amber-100'),
        emoji: String(r[4] || '💌'),
        likes: Number(r[5]) || 0,
        createdAt: String(r[6] || ''),
        likedByMe: !!liked[String(r[0])],
        reportedByMe: !!reported[String(r[0])],
        hidden: String(r[8] || '') === 'hidden',
        canDelete: !!me && !me.isAdmin && !!author && author === me.email.toLowerCase()
      };
    })
    .filter(function (n) { return n.id && n.message && (!n.hidden || (me && me.isAdmin)); })
    .reverse();
}

function addNote(form, token) {
  const me = getSession_(token);
  if (!me) return LOGIN_REQUIRED;
  if (isBanned_(me.email)) return BANNED_MSG;
  try {
    form = form || {};
    const message = String(form.message || '').trim().slice(0, MAX_NOTE_LENGTH);
    if (!message) return { success: false, error: 'กรุณาพิมพ์ข้อความ' };
    if (!throttle_('note_' + me.email, 20)) return { success: false, error: 'โพสต์ถี่เกินไป รอสักครู่แล้วลองใหม่นะ' };

    const toWho = String(form.toWho || '').trim().slice(0, MAX_TOWHO_LENGTH) || 'ถึงทุกคน';
    const bgColor = ALLOWED_COLORS.indexOf(form.bgColor) !== -1 ? form.bgColor : 'bg-amber-100';
    const emoji = String(form.emoji || '💖').slice(0, 8);

    return withLock_(function () {
      const sheet = getTargetSheet();
      if (!sheet.getRange(1, 8).getValue()) sheet.getRange(1, 8).setValue('AuthorEmail');
      const id = 'NOTE-' + Date.now().toString().slice(-6) + '-' + Utilities.getUuid().slice(0, 4);
      // โน้ตยังเป็นนิรนามบนหน้าเว็บ: เก็บอีเมลผู้เขียนไว้ในชีตเพื่อให้แอดมินตรวจสอบเท่านั้น
      sheet.appendRow([id, safeCell_(toWho), safeCell_(message), bgColor, emoji, 0, now_(), safeCell_(me.email)]);
      return { success: true };
    });
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

function likeNote(id, token) {
  const me = getSession_(token);
  if (!me) return LOGIN_REQUIRED;
  try {
    return withLock_(function () {
      const sheet = getTargetSheet();
      const row = findRow_(sheet, id);
      if (!row) return { success: false, error: 'ไม่พบโน้ตนี้' };

      if (isBanned_(me.email)) return BANNED_MSG;
      const ls = getLikesSheet_();
      const email = me.email.toLowerCase();
      if (ls.getLastRow() > 1) {
        const vals = ls.getRange(2, 1, ls.getLastRow() - 1, 2).getValues();
        const dup = vals.some(function (v) {
          return String(v[0]) === String(id) && String(v[1]).toLowerCase() === email;
        });
        if (dup) return { success: false, already: true, error: 'คุณกดหัวใจโน้ตนี้แล้ว' };
      }
      ls.appendRow([id, email, now_()]);
      const cell = sheet.getRange(row, 6);
      const n = (Number(cell.getValue()) || 0) + 1;
      cell.setValue(n);
      return { success: true, newLikes: n };
    });
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// แอดมินลบได้ทุกโน้ต / เจ้าของโน้ตลบของตัวเองได้
function deleteNote(id, token) {
  const me = getSession_(token);
  if (!me) return LOGIN_REQUIRED;
  try {
    return withLock_(function () {
      const sheet = getTargetSheet();
      const row = findRow_(sheet, id);
      if (!row) return { success: false, error: 'ไม่พบโน้ตนี้' };
      const author = String(sheet.getRange(row, 8).getValue() || '').toLowerCase();
      if (!me.isAdmin && author !== me.email.toLowerCase()) {
        return { success: false, error: 'ไม่มีสิทธิ์ลบโน้ตนี้' };
      }
      sheet.deleteRow(row);
      return { success: true };
    });
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

/* ---------- AI Chatbot ---------- */
function callGemini_(userMessage) {
  const apiKey = prop_('GEMINI_API_KEY');
  if (!apiKey) return { success: false, error: 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY ใน Script Properties' };

  const msg = String(userMessage || '').trim().slice(0, MAX_CHAT_LENGTH);
  if (!msg) return { success: false, error: 'กรุณาพิมพ์ข้อความ' };

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent';
  const payload = {
    system_instruction: {
      parts: [{
        text: 'คุณคือ "น้องฮีลใจ" AI Chatbot ผู้ช่วยรับฟังและส่งพลังบวกประจำเว็บ Positivity Board\n' +
          'หน้าที่: ตอบด้วยน้ำเสียงอบอุ่น ให้กำลังใจ สั้นๆ 2-4 บรรทัด ใส่อีโมจิน่ารักๆ'
      }]
    },
    contents: [{ role: 'user', parts: [{ text: msg }] }]
  };

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const json = JSON.parse(res.getContentText());
  const text = json.candidates && json.candidates[0] && json.candidates[0].content &&
    json.candidates[0].content.parts && json.candidates[0].content.parts[0] &&
    json.candidates[0].content.parts[0].text;

  if (text) return { success: true, reply: text };
  if (json.error) return { success: false, error: 'API Error: ' + json.error.message };
  return { success: false, error: 'ไม่สามารถประมวลผลคำตอบได้' };
}

function askAI(userMessage, token) {
  const me = getSession_(token);
  if (!me) return LOGIN_REQUIRED;
  try {
    if (isBanned_(me.email)) return BANNED_MSG;
    if (!throttle_('chat_' + me.email, 4)) return { success: false, error: 'พิมพ์เร็วไปนิดนึง รอสักครู่นะ 💭' };
    return callGemini_(userMessage);
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// รันใน editor เพื่อทดสอบโมเดล แล้วดู Execution log
function testGeminiDirect() {
  Logger.log(JSON.stringify(callGemini_('สวัสดี ทักทายสั้นๆ หน่อย')));
}

/* ---------- ฟังก์ชันแอดมิน / รายงาน ---------- */

// ซ่อนโน้ต (ยังอยู่ในชีต กู้คืนได้) หรือกู้คืน
function hideNote(id, hidden, token) {
  const g = adminGate_(token);
  if (g.fail) return g.fail;
  try {
    return withLock_(function () {
      const sheet = getTargetSheet();
      const row = findRow_(sheet, id);
      if (!row) return { success: false, error: 'ไม่พบโน้ตนี้' };
      if (!sheet.getRange(1, 9).getValue()) sheet.getRange(1, 9).setValue('Status');
      sheet.getRange(row, 9).setValue(hidden ? 'hidden' : '');
      if (hidden) setReportStatus_(id, 'resolved');
      return { success: true };
    });
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// ผู้ใช้รายงานโน้ตที่ไม่เหมาะสม (คนละ 1 ครั้งต่อโน้ต)
function reportNote(id, token) {
  const me = getSession_(token);
  if (!me) return LOGIN_REQUIRED;
  if (isBanned_(me.email)) return BANNED_MSG;
  try {
    return withLock_(function () {
      if (!findRow_(getTargetSheet(), id)) return { success: false, error: 'ไม่พบโน้ตนี้' };
      const s = reportsSheet_();
      const email = me.email.toLowerCase();
      if (s.getLastRow() > 1) {
        const dup = s.getRange(2, 1, s.getLastRow() - 1, 2).getValues().some(function (v) {
          return String(v[0]) === String(id) && String(v[1]).toLowerCase() === email;
        });
        if (dup) return { success: false, error: 'คุณรายงานโน้ตนี้ไปแล้ว' };
      }
      s.appendRow([id, safeCell_(email), now_(), 'open']);
      return { success: true };
    });
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

function getAdminData(token) {
  const g = adminGate_(token);
  if (g.fail) return g.fail;
  try {
    const notes = {};
    getTargetSheet().getDataRange().getValues().slice(1).forEach(function (r) {
      notes[String(r[0])] = {
        toWho: String(r[1]), message: String(r[2]),
        author: String(r[7] || ''), hidden: String(r[8] || '') === 'hidden'
      };
    });
    const counts = {};
    const rs = reportsSheet_();
    if (rs.getLastRow() > 1) {
      rs.getRange(2, 1, rs.getLastRow() - 1, 4).getValues().forEach(function (v) {
        if (v[3] === 'open') counts[String(v[0])] = (counts[String(v[0])] || 0) + 1;
      });
    }
    const reports = Object.keys(counts)
      .filter(function (id) { return notes[id]; })
      .map(function (id) {
        return { id: id, count: counts[id], toWho: notes[id].toWho, message: notes[id].message, author: notes[id].author, hidden: notes[id].hidden };
      })
      .sort(function (a, b) { return b.count - a.count; });
    return { success: true, reports: reports, bans: bannedList_() };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

function dismissReports(id, token) {
  const g = adminGate_(token);
  if (g.fail) return g.fail;
  try {
    return withLock_(function () { setReportStatus_(id, 'dismissed'); return { success: true }; });
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// แบนผู้เขียนโน้ต (อ้างอิงจากอีเมลที่เก็บไว้ใน AuthorEmail)
function banUser(noteId, token) {
  const g = adminGate_(token);
  if (g.fail) return g.fail;
  try {
    return withLock_(function () {
      const sheet = getTargetSheet();
      const row = findRow_(sheet, noteId);
      if (!row) return { success: false, error: 'ไม่พบโน้ตนี้' };
      const author = String(sheet.getRange(row, 8).getValue() || '').trim().toLowerCase();
      if (!author) return { success: false, error: 'โน้ตเก่านี้ไม่มีข้อมูลผู้เขียน จึงแบนไม่ได้' };
      if (isAdmin_(author)) return { success: false, error: 'ไม่สามารถแบนแอดมินได้' };
      if (!isBanned_(author)) bansSheet_().appendRow([safeCell_(author), now_(), safeCell_(g.me.email)]);
      setReportStatus_(noteId, 'resolved');
      return { success: true };
    });
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

function unbanUser(email, token) {
  const g = adminGate_(token);
  if (g.fail) return g.fail;
  try {
    return withLock_(function () {
      const s = bansSheet_();
      const e = String(email).toLowerCase();
      for (let i = s.getLastRow(); i >= 2; i--) {
        if (String(s.getRange(i, 1).getValue()).toLowerCase() === e) s.deleteRow(i);
      }
      return { success: true };
    });
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// รันใน editor เพื่อเช็กค่า OAuth โดยไม่โชว์ความลับ แล้วดู Execution log
function checkOAuth() {
  const id = prop_('OAUTH_CLIENT_ID');
  const secret = prop_('OAUTH_CLIENT_SECRET');
  Logger.log('Client ID ยาว ' + id.length + ' ตัวอักษร');
  Logger.log('ขึ้นต้นด้วย: ' + id.slice(0, 12) + ' ...');
  Logger.log('ลงท้ายด้วย .apps.googleusercontent.com ? ' + /\.apps\.googleusercontent\.com$/.test(id));
  Logger.log('ขึ้นต้นด้วยตัวเลขแล้วตามด้วย - ? ' + /^\d+-/.test(id));
  Logger.log('Client secret ขึ้นต้นด้วย GOCSPX- ? ' + /^GOCSPX-/.test(secret));
  Logger.log('APP_URL = ' + appUrl_());
}
