require('dotenv').config();

// Smart Nabd production backend
// Node.js 20+ — Gemini and database credentials stay on the server.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.7-flash,gemini-3.5-flash')
  .split(',').map(s => s.trim()).filter(Boolean)
  .filter((model, index, arr) => model !== GEMINI_MODEL && arr.indexOf(model) === index);
const GEMINI_MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES || 3);
const GEMINI_RETRY_BASE_MS = Number(process.env.GEMINI_RETRY_BASE_MS || 1200);
const MAX_BODY_BYTES = 256 * 1024;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE || 20);
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const SESSION_DAYS_REMEMBER = Number(process.env.SESSION_DAYS_REMEMBER || 30);
const SESSION_DAYS_NORMAL = Number(process.env.SESSION_DAYS_NORMAL || 1);
const PASSWORD_RESET_MINUTES = Number(process.env.PASSWORD_RESET_MINUTES || 30);
const EMAIL_VERIFY_HOURS = Number(process.env.EMAIL_VERIFY_HOURS || 24);
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER || 'smartnabd.support@gmail.com';
const mailer = SMTP_HOST && SMTP_USER && SMTP_PASS ? nodemailer.createTransport({host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: {user: SMTP_USER, pass: SMTP_PASS}}) : null;
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 10);
const PREMIUM_DAILY_LIMIT = Number(process.env.PREMIUM_DAILY_LIMIT || 100);
const DATABASE_URL = process.env.DATABASE_URL || '';
const isProduction = process.env.NODE_ENV === 'production';

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.DB_POOL_MAX || 5),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;

const requestLog = new Map();
const TASK_INSTRUCTIONS = {
  doctor_analysis: 'نظّم الحالة السريرية وقدّم احتمالات تفريقية وأسبابًا تدعم أو تضعف كل احتمال، مع أسئلة أو فحوصات قد تكون مفيدة للمراجعة الطبية. لا تقدّم تشخيصًا نهائيًا.',
  doctor_clinical_summary: 'أنشئ ملخصًا سريريًا منظمًا ومختصرًا للطبيب مع فصل المعلومات المدخلة عن الاستنتاجات.',
  doctor_differential_support: 'قدّم دعمًا للتشخيص التفريقي فقط: احتمالات مرتبة منطقيًا مع الأدلة المؤيدة والمعارضة وما يحتاج تحققًا. لا تستبدل قرار الطبيب.',
  doctor_clinical_note: 'حوّل البيانات إلى مسودة ملاحظة سريرية منظمة قابلة للمراجعة والتعديل.',
  doctor_lab_summary: 'نظّم نتائج المختبر ولفت الانتباه إلى القيم التي تستحق المراجعة وفق البيانات والنطاقات التي أدخلها المستخدم. لا تشخّص.',
  nurse_triage: 'نظّم فرز الحالة اعتمادًا على الشكوى والعلامات الحيوية، واذكر مؤشرات تستدعي تصعيدًا أو تقييمًا عاجلًا دون اتخاذ قرار علاجي مستقل.',
  nurse_vitals: 'حوّل العلامات الحيوية إلى ملخص واضح مع ملاحظات تنظيمية فقط، ولفت الانتباه إلى القيم غير المعتادة مع ضرورة الرجوع للبروتوكول.',
  nurse_note: 'أنشئ مسودة ملاحظة تمريضية منظمة من البيانات المدخلة.',
  nurse_handoff: 'أنشئ ملخص تسليم تمريضي سريع ومنظم يوضح الحالة والمهام والملاحظات المهمة.',
  nurse_assessment: 'أنشئ تقييمًا تمريضيًا منظمًا من المعلومات المدخلة مع نقاط تحتاج تحققًا.',
  patient_triage: 'قدّم إرشادًا أوليًا آمنًا ومفهومًا للمريض بناءً على الأعراض، مع التركيز على علامات الخطر ومتى يجب طلب رعاية عاجلة. لا تشخّص.',
  patient_medication_info: 'اشرح المعلومات العامة عن الدواء المذكور بشكل تعليمي، مع التنبيه إلى أن الجرعات والملاءمة تعتمد على الوصفة والسياق الطبي ومصدر دوائي موثوق.',
  patient_red_flags: 'استخرج علامات الخطر المحتملة من الأعراض المدخلة ووضّح متى يلزم طلب رعاية عاجلة. لا تشخّص.',
  patient_summary: 'لخّص الأعراض المدخلة بلغة واضحة ومنظمة للمريض أو لمشاركته مع المختص.',
  patient_first_aid: 'قدّم إرشادات إسعاف أولي عامة وآمنة للحالة الموصوفة، مع ذكر متى يجب طلب الطوارئ. لا تقدّم تعليمات خطرة أو بديلًا عن الرعاية الطبية.',
  pharmacist_drug_review: 'نظّم مراجعة الدواء من البيانات المدخلة، وميّز بين المعلومات المؤكدة وما يحتاج تحققًا من مرجع دوائي موثوق.',
  pharmacist_alternatives: 'نظّم البحث عن بدائل بحسب المادة الفعالة مع التأكيد على مطابقة التركيز والشكل وطريق الإعطاء والحساسية والبلد، ولا تعتمد بديلًا تلقائيًا.',
  pharmacist_interactions: 'حلّل قائمة الأدوية بحثًا عن تداخلات محتملة، مع اعتبار النتيجة للمراجعة وليس مرجعًا دوائيًا نهائيًا.',
  pharmacist_dose_review: 'نظّم مراجعة الجرعة من البيانات المدخلة، ولا تخمّن جرعة ناقصة؛ اطلب الرجوع إلى مرجع دوائي موثوق ووصفة الطبيب.'
};

function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...headers
  });
  res.end(body);
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
}

function rateAllowed(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const existing = requestLog.get(ip) || [];
  const recent = existing.filter(t => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    requestLog.set(ip, recent);
    return false;
  }
  recent.push(now);
  requestLog.set(ip, recent);
  return true;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try { cookies[key] = decodeURIComponent(value); } catch (_) { cookies[key] = value; }
  }
  return cookies;
}

function cookie(name, value, maxAgeSeconds) {
  const secure = isProduction ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearCookie(name) {
  const secure = isProduction ? '; Secure' : '';
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = '';
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (_) { reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function authError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function initDatabase() {
  if (!pool) {
    console.warn('[DB] DATABASE_URL is not configured. Authentication will remain unavailable.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email VARCHAR(254) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      plan VARCHAR(20) NOT NULL DEFAULT 'free' CHECK (plan IN ('free','premium')),
      email_verified BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash CHAR(64) UNIQUE NOT NULL,
      purpose VARCHAR(30) NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS auth_tokens_user_purpose_idx ON auth_tokens(user_id, purpose);
    CREATE INDEX IF NOT EXISTS auth_tokens_expires_idx ON auth_tokens(expires_at);
    CREATE TABLE IF NOT EXISTS sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash CHAR(64) UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS ai_usage (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task VARCHAR(100) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ai_usage_user_created_idx ON ai_usage(user_id, created_at);
  `);
  await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
  await pool.query('DELETE FROM auth_tokens WHERE expires_at < NOW()');
  console.log('[DB] PostgreSQL initialized.');
}

async function createSession(userId, res, days = SESSION_DAYS_REMEMBER) {
  const token = randomToken();
  const tokenHash = hashToken(token);
  await pool.query(
    'INSERT INTO sessions(user_id, token_hash, expires_at) VALUES($1,$2,NOW()+($3 || \' days\')::interval)',
    [userId, tokenHash, days]
  );
  res.setHeader('Set-Cookie', cookie('smart_nabd_session', token, days * 86400));
}

async function currentUser(req) {
  if (!pool) return null;
  const token = parseCookies(req).smart_nabd_session;
  if (!token) return null;
  const tokenHash = hashToken(token);
  const result = await pool.query(`
    SELECT u.id, u.email, u.plan, u.created_at
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at > NOW()
    LIMIT 1
  `, [tokenHash]);
  return result.rows[0] || null;
}

async function usageInfo(userId, plan) {
  const limit = plan === 'premium' ? PREMIUM_DAILY_LIMIT : FREE_DAILY_LIMIT;
  const result = await pool.query(`
    SELECT COUNT(*)::int AS used
    FROM ai_usage
    WHERE user_id=$1 AND created_at >= date_trunc('day', NOW())
  `, [userId]);
  const used = result.rows[0]?.used || 0;
  return { used, limit, remaining: Math.max(0, limit - used) };
}

async function consumeUsage(userId, plan, task) {
  const limit = plan === 'premium' ? PREMIUM_DAILY_LIMIT : FREE_DAILY_LIMIT;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
    const result = await client.query(`
      SELECT COUNT(*)::int AS used
      FROM ai_usage
      WHERE user_id=$1 AND created_at >= date_trunc('day', NOW())
    `, [userId]);
    const used = result.rows[0]?.used || 0;
    if (used >= limit) {
      await client.query('ROLLBACK');
      return { allowed: false, used, limit, remaining: 0 };
    }
    const inserted = await client.query(
      'INSERT INTO ai_usage(user_id, task) VALUES($1,$2) RETURNING id',
      [userId, String(task || 'unknown').slice(0, 100)]
    );
    await client.query('COMMIT');
    return {
      allowed: true,
      usageId: inserted.rows[0].id,
      used: used + 1,
      limit,
      remaining: Math.max(0, limit - used - 1)
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function refundUsage(usageId) {
  if (!usageId || !pool) return;
  await pool.query('DELETE FROM ai_usage WHERE id=$1', [usageId]);
}

function buildPrompt(task, data, language) {
  const lang = language === 'en' ? 'English' : 'Arabic';
  const instruction = TASK_INSTRUCTIONS[task] || 'حلّل البيانات بشكل منظم وآمن، دون ادعاء تشخيص نهائي.';
  return [
    'أنت مساعد صحي رقمي داخل تطبيق Smart Nabd.',
    'المخرجات تعليمية/تنظيمية وداعمة للمختص أو المستخدم وليست تشخيصًا طبيًا نهائيًا ولا بديلًا عن الطبيب أو الصيدلاني أو بروتوكولات المؤسسة.',
    'لا تخترع بيانات غير موجودة. إذا كانت معلومات أساسية ناقصة فاذكر ذلك بوضوح.',
    'إذا ظهرت مؤشرات طارئة في البيانات، اجعل التنبيه لطلب رعاية عاجلة واضحًا.',
    `المهمة: ${instruction}`,
    `لغة الإجابة: ${lang}.`,
    'بيانات الحالة بصيغة JSON:',
    JSON.stringify(data ?? {}, null, 2)
  ].join('\n\n');
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableGeminiError(status, message) {
  const text = String(message || '').toLowerCase();
  return status === 408 || status === 429 || status >= 500 ||
    text.includes('high demand') ||
    text.includes('temporarily unavailable') ||
    text.includes('try again later') ||
    text.includes('resource exhausted') ||
    text.includes('unavailable');
}

async function callGeminiModel(prompt, model, maxRetries = GEMINI_MAX_RETRIES) {
  if (!GEMINI_API_KEY) throw authError('GEMINI_API_KEY غير مهيأ على الخادم.', 503);

  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = payload?.error?.message || 'Gemini API request failed.';
        const error = authError(message, response.status === 429 ? 429 : response.status >= 500 ? 503 : 502);
        error.retryable = isRetryableGeminiError(response.status, message);
        throw error;
      }
      const text = (payload?.candidates || [])
        .flatMap(c => c?.content?.parts || [])
        .map(p => p?.text || '')
        .join('')
        .trim();
      if (!text) throw authError('Gemini returned an empty response.', 502);
      return { text, model };
    } catch (error) {
      lastError = error;
      const retryable = error.name === 'AbortError' || error.retryable || isRetryableGeminiError(error.statusCode, error.message);
      const hasRetryLeft = attempt < maxRetries - 1;
      if (!retryable || !hasRetryLeft) break;
      const delay = GEMINI_RETRY_BASE_MS * (2 ** attempt) + Math.floor(Math.random() * 500);
      console.warn(`[Gemini] ${model} transient failure; retry ${attempt + 1}/${maxRetries - 1} in ${delay}ms: ${error.message}`);
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || authError('Gemini API request failed.', 502);
}

async function callGemini(prompt) {
  const models = [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS];
  let lastError;
  for (let index = 0; index < models.length; index++) {
    const model = models[index];
    try {
      const result = await callGeminiModel(prompt, model, index === 0 ? GEMINI_MAX_RETRIES : Math.max(2, GEMINI_MAX_RETRIES - 1));
      if (index > 0) console.warn(`[Gemini] Fallback model succeeded: ${model}`);
      return result;
    } catch (error) {
      lastError = error;
      console.error(`[Gemini] ${model} failed: ${error.message}`);
      if (!isRetryableGeminiError(error.statusCode, error.message) && error.name !== 'AbortError') break;
    }
  }
  throw lastError || authError('Gemini API request failed.', 502);
}

async function requireUser(req, res) {
  if (!pool) {
    send(res, 503, { error: 'قاعدة البيانات غير مهيأة على الخادم بعد.' });
    return null;
  }
  const user = await currentUser(req);
  if (!user) {
    send(res, 401, { error: 'يجب تسجيل الدخول أولًا.' });
    return null;
  }
  return user;
}


function appBaseUrl(req) {
  return APP_BASE_URL || `https://${req.headers.host || 'smart-nabd.onrender.com'}`;
}

function makeAuthToken() {
  const token = randomToken();
  return { token, tokenHash: hashToken(token) };
}

async function sendAuthEmail(to, subject, html) {
  if (!mailer) {
    console.warn('[MAIL] SMTP is not configured; email could not be sent to', to);
    throw authError('خدمة البريد الإلكتروني غير مهيأة على الخادم حاليًا.', 503);
  }
  await mailer.sendMail({ from: MAIL_FROM, to, subject, html });
}

function emailTemplate(title, intro, buttonText, buttonUrl, footer) {
  return `<!doctype html><html lang="ar" dir="rtl"><body style="font-family:Arial,sans-serif;background:#f5f8fb;padding:30px;color:#1f2937"><div style="max-width:620px;margin:auto;background:#fff;border-radius:18px;padding:32px;box-shadow:0 8px 30px rgba(0,0,0,.08)"><h2 style="margin-top:0">نبض الذكي | Smart Nabd</h2><h3>${title}</h3><p>${intro}</p><p><a href="${buttonUrl}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#0ea5a8;color:#fff;text-decoration:none">${buttonText}</a></p><p style="font-size:13px;color:#6b7280">${footer}</p></div></body></html>`;
}

async function issueVerificationEmail(req, user) {
  const {token, tokenHash} = makeAuthToken();
  await pool.query("DELETE FROM auth_tokens WHERE user_id=$1 AND purpose='verify_email'", [user.id]);
  await pool.query("INSERT INTO auth_tokens(user_id,token_hash,purpose,expires_at) VALUES($1,$2,'verify_email',NOW()+($3 || ' hours')::interval)", [user.id, tokenHash, EMAIL_VERIFY_HOURS]);
  const url = `${appBaseUrl(req)}/?verify=${encodeURIComponent(token)}`;
  await sendAuthEmail(user.email, 'تأكيد بريدك الإلكتروني في نبض الذكي', emailTemplate('تأكيد البريد الإلكتروني', 'اضغط الزر لتأكيد بريدك الإلكتروني وتفعيل حسابك.', 'تأكيد البريد الإلكتروني', url, `الرابط صالح لمدة ${EMAIL_VERIFY_HOURS} ساعة.`));
}

async function issuePasswordResetEmail(req, user) {
  const {token, tokenHash} = makeAuthToken();
  await pool.query("DELETE FROM auth_tokens WHERE user_id=$1 AND purpose='reset_password'", [user.id]);
  await pool.query("INSERT INTO auth_tokens(user_id,token_hash,purpose,expires_at) VALUES($1,$2,'reset_password',NOW()+($3 || ' minutes')::interval)", [user.id, tokenHash, PASSWORD_RESET_MINUTES]);
  const url = `${appBaseUrl(req)}/?reset=${encodeURIComponent(token)}`;
  await sendAuthEmail(user.email, 'إعادة تعيين كلمة مرور نبض الذكي', emailTemplate('إعادة تعيين كلمة المرور', 'طلبنا إعادة تعيين كلمة مرور حسابك. إذا كنت أنت، استخدم الزر التالي.', 'إعادة تعيين كلمة المرور', url, `الرابط صالح لمدة ${PASSWORD_RESET_MINUTES} دقيقة.`));
}

async function handleAuth(req, res, pathname) {
  if (!pool) return send(res, 503, { error: 'قاعدة البيانات غير مهيأة على الخادم بعد.' });

  if (req.method === 'POST' && pathname === '/api/auth/register') {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    if (!validEmail(email)) return send(res, 400, { error: 'أدخل بريدًا إلكترونيًا صحيحًا.' });
    if (password.length < 8) return send(res, 400, { error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.' });
    if (password.length > 128) return send(res, 400, { error: 'كلمة المرور طويلة جدًا.' });
    const existing = await pool.query('SELECT id FROM users WHERE email=$1 LIMIT 1', [email]);
    if (existing.rowCount) return send(res, 409, { error: 'هذا البريد مستخدم بالفعل. سجّل الدخول بدلًا من إنشاء حساب جديد.' });
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users(email,password_hash,plan,email_verified) VALUES($1,$2,\'free\',$3) RETURNING id,email,plan,email_verified,created_at',
      [email, passwordHash, mailer ? false : true]
    );
    const user = result.rows[0];
    if (mailer) {
      try { await issueVerificationEmail(req, user); }
      catch (e) { await pool.query('DELETE FROM users WHERE id=$1', [user.id]); throw e; }
    }
    await createSession(user.id, res, body.rememberMe === false ? SESSION_DAYS_NORMAL : SESSION_DAYS_REMEMBER);
    return send(res, 201, { ok: true, user, emailVerificationRequired: Boolean(mailer), usage: { used: 0, limit: FREE_DAILY_LIMIT, remaining: FREE_DAILY_LIMIT } });
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const result = await pool.query('SELECT id,email,password_hash,plan,email_verified,created_at FROM users WHERE email=$1 LIMIT 1', [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return send(res, 401, { error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' });
    }
    if (mailer && !user.email_verified) return send(res, 403, { error: 'يرجى تأكيد بريدك الإلكتروني أولًا. افحص بريدك أو اطلب إعادة إرسال رسالة التأكيد.', code: 'EMAIL_NOT_VERIFIED' });
    await createSession(user.id, res, body.rememberMe === false ? SESSION_DAYS_NORMAL : SESSION_DAYS_REMEMBER);
    const usage = await usageInfo(user.id, user.plan);
    return send(res, 200, { ok: true, user: { id: user.id, email: user.email, plan: user.plan, email_verified: user.email_verified, created_at: user.created_at }, usage });
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const token = parseCookies(req).smart_nabd_session;
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [hashToken(token)]);
    return send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie('smart_nabd_session') });
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'غير مسجل الدخول.' });
    if (mailer && user.email_verified === false) return send(res, 403, { error: 'يرجى تأكيد بريدك الإلكتروني أولًا.', code: 'EMAIL_NOT_VERIFIED' });
    const usage = await usageInfo(user.id, user.plan);
    return send(res, 200, { ok: true, user, usage });
  }

  if (req.method === 'POST' && pathname === '/api/auth/forgot-password') {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    if (!validEmail(email)) return send(res, 400, { error: 'أدخل بريدًا إلكترونيًا صحيحًا.' });
    const result = await pool.query('SELECT id,email FROM users WHERE email=$1 LIMIT 1', [email]);
    if (result.rowCount && mailer) await issuePasswordResetEmail(req, result.rows[0]);
    return send(res, 200, { ok: true, message: 'إذا كان البريد مسجلًا، ستصلك رسالة لإعادة تعيين كلمة المرور.' });
  }

  if (req.method === 'POST' && pathname === '/api/auth/resend-verification') {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const result = await pool.query('SELECT id,email,email_verified FROM users WHERE email=$1 LIMIT 1', [email]);
    if (result.rowCount && mailer && !result.rows[0].email_verified) await issueVerificationEmail(req, result.rows[0]);
    return send(res, 200, { ok: true, message: 'إذا كان الحساب يحتاج تأكيدًا، ستصلك رسالة جديدة.' });
  }

  if (req.method === 'POST' && pathname === '/api/auth/change-password') {
    const user = await requireUser(req, res);
    if (!user) return null;
    const body = await readJson(req);
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    const result = await pool.query('SELECT password_hash FROM users WHERE id=$1', [user.id]);
    if (!result.rowCount || !(await bcrypt.compare(currentPassword, result.rows[0].password_hash))) return send(res, 401, { error: 'كلمة المرور الحالية غير صحيحة.' });
    if (newPassword.length < 8 || newPassword.length > 128) return send(res, 400, { error: 'كلمة المرور الجديدة يجب أن تكون بين 8 و128 حرفًا.' });
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, user.id]);
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [user.id]);
    await createSession(user.id, res, SESSION_DAYS_REMEMBER);
    return send(res, 200, { ok: true, message: 'تم تغيير كلمة المرور بنجاح.' });
  }

  if (req.method === 'POST' && pathname === '/api/auth/reset-password') {
    const body = await readJson(req);
    const token = String(body.token || '');
    const newPassword = String(body.newPassword || '');
    if (!token) return send(res, 400, { error: 'رابط إعادة التعيين غير صالح.' });
    if (newPassword.length < 8 || newPassword.length > 128) return send(res, 400, { error: 'كلمة المرور الجديدة يجب أن تكون بين 8 و128 حرفًا.' });
    const result = await pool.query("SELECT user_id FROM auth_tokens WHERE token_hash=$1 AND purpose='reset_password' AND expires_at>NOW() LIMIT 1", [hashToken(token)]);
    if (!result.rowCount) return send(res, 400, { error: 'انتهت صلاحية رابط إعادة التعيين أو أنه غير صالح.' });
    const userId = result.rows[0].user_id;
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, userId]);
    await pool.query('DELETE FROM auth_tokens WHERE user_id=$1 AND purpose=\'reset_password\'', [userId]);
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
    await createSession(userId, res, SESSION_DAYS_REMEMBER);
    const userResult = await pool.query('SELECT id,email,plan,email_verified,created_at FROM users WHERE id=$1', [userId]);
    const user = userResult.rows[0];
    const usage = await usageInfo(userId, user.plan);
    return send(res, 200, { ok: true, message: 'تم تعيين كلمة المرور الجديدة بنجاح.', user, usage });
  }

  if (req.method === 'GET' && pathname === '/api/auth/verify-email') {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token') || '';
    const result = await pool.query("SELECT user_id FROM auth_tokens WHERE token_hash=$1 AND purpose='verify_email' AND expires_at>NOW() LIMIT 1", [hashToken(token)]);
    if (!result.rowCount) return send(res, 400, { error: 'رابط تأكيد البريد غير صالح أو منتهي الصلاحية.' });
    const userId = result.rows[0].user_id;
    await pool.query('UPDATE users SET email_verified=TRUE WHERE id=$1', [userId]);
    await pool.query("DELETE FROM auth_tokens WHERE user_id=$1 AND purpose='verify_email'", [userId]);
    return send(res, 200, { ok: true, message: 'تم تأكيد البريد الإلكتروني بنجاح.' });
  }

  return null;
}

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, aiConfigured: Boolean(GEMINI_API_KEY), databaseConfigured: Boolean(pool), model: GEMINI_MODEL, fallbackModels: GEMINI_FALLBACK_MODELS });
  }

  if (url.pathname.startsWith('/api/auth/')) {
    const handled = await handleAuth(req, res, url.pathname);
    if (handled !== null) return handled;
  }

  if (req.method === 'POST' && url.pathname === '/api/gemini/analyze') {
    if (!rateAllowed(req)) return send(res, 429, { error: 'تم تجاوز حد الطلبات مؤقتًا. حاول بعد دقيقة.' });
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      const body = await readJson(req);
      const task = String(body.task || '');
      if (!task) return send(res, 400, { error: 'Missing task.' });
      const usage = await consumeUsage(user.id, user.plan, task);
      if (!usage.allowed) {
        return send(res, 429, {
          error: user.plan === 'premium' ? 'وصلت إلى حد استخدام Premium اليومي.' : 'وصلت إلى حد الاستخدام المجاني اليومي. يمكنك الترقية إلى Premium لاحقًا.',
          usage
        });
      }
      const prompt = buildPrompt(task, body.data || {}, body.language);
      try {
        const result = await callGemini(prompt);
        return send(res, 200, { ok: true, text: result.text, model: result.model, usage });
      } catch (error) {
        await refundUsage(usage.usageId).catch(refundError => console.error('[Usage refund]', refundError.message));
        throw error;
      }
    } catch (error) {
      const status = error.statusCode || 500;
      const publicMessage =
        status === 503 ? 'الذكاء الاصطناعي أو قاعدة البيانات غير مهيأة على الخادم بعد.' :
        status === 429 ? 'تم تجاوز حد الطلبات من Gemini مؤقتًا. حاول لاحقًا.' :
        status === 413 ? 'البيانات المرسلة كبيرة جدًا.' :
        'تعذر تنفيذ طلب الذكاء الاصطناعي حاليًا.';
      console.error('[Gemini]', error.message);
      return send(res, status, { error: publicMessage });
    }
  }

  if (req.method === 'GET') {
    let filePath = path.join(__dirname, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!filePath.startsWith(__dirname) || filePath.includes('..')) return send(res, 404, { error: 'Not found' });
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const types = {
        '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml'
      };
      res.writeHead(200, {
        'Content-Type': types[ext] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'strict-origin-when-cross-origin'
      });
      return fs.createReadStream(filePath).pipe(res);
    }
  }
  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  router(req, res).catch(error => {
    console.error('[Server]', error);
    if (!res.headersSent) send(res, 500, { error: 'Internal server error.' });
  });
});

initDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`Smart Nabd running on http://localhost:${PORT}`);
    console.log(`Gemini model: ${GEMINI_MODEL}`);
    console.log(`Gemini fallback models: ${GEMINI_FALLBACK_MODELS.join(', ') || 'none'}`);
    console.log(`Gemini key configured: ${Boolean(GEMINI_API_KEY)}`);
    console.log(`Database configured: ${Boolean(pool)}`);
  });
}).catch(error => {
  console.error('[DB] Initialization failed:', error.message);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  await pool?.end().catch(() => {});
  process.exit(0);
});