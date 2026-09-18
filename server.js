require('dotenv').config();
// Smart Nabd production backend
// Node.js 18+ — the Gemini API key stays ONLY on the server.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const MAX_BODY_BYTES = 256 * 1024;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE || 20);

const requestLog = new Map();

const TASK_INSTRUCTIONS = {
  doctor_analysis: "نظّم الحالة السريرية وقدّم احتمالات تفريقية وأسبابًا تدعم أو تضعف كل احتمال، مع أسئلة أو فحوصات قد تكون مفيدة للمراجعة الطبية. لا تقدّم تشخيصًا نهائيًا.",
  doctor_clinical_summary: "أنشئ ملخصًا سريريًا منظمًا ومختصرًا للطبيب مع فصل المعلومات المدخلة عن الاستنتاجات.",
  doctor_differential_support: "قدّم دعمًا للتشخيص التفريقي فقط: احتمالات مرتبة منطقيًا مع الأدلة المؤيدة والمعارضة وما يحتاج تحققًا. لا تستبدل قرار الطبيب.",
  doctor_clinical_note: "حوّل البيانات إلى مسودة ملاحظة سريرية منظمة قابلة للمراجعة والتعديل.",
  doctor_lab_summary: "نظّم نتائج المختبر ولفت الانتباه إلى القيم التي تستحق المراجعة وفق البيانات والنطاقات التي أدخلها المستخدم. لا تشخّص.",
  nurse_triage: "نظّم فرز الحالة اعتمادًا على الشكوى والعلامات الحيوية، واذكر مؤشرات تستدعي تصعيدًا أو تقييمًا عاجلًا دون اتخاذ قرار علاجي مستقل.",
  nurse_vitals: "حوّل العلامات الحيوية إلى ملخص واضح مع ملاحظات تنظيمية فقط، ولفت الانتباه إلى القيم غير المعتادة مع ضرورة الرجوع للبروتوكول.",
  nurse_note: "أنشئ مسودة ملاحظة تمريضية منظمة من البيانات المدخلة.",
  nurse_handoff: "أنشئ ملخص تسليم تمريضي سريع ومنظم يوضح الحالة والمهام والملاحظات المهمة.",
  nurse_assessment: "أنشئ تقييمًا تمريضيًا منظمًا من المعلومات المدخلة مع نقاط تحتاج تحققًا.",
  patient_triage: "قدّم إرشادًا أوليًا آمنًا ومفهومًا للمريض بناءً على الأعراض، مع التركيز على علامات الخطر ومتى يجب طلب رعاية عاجلة. لا تشخّص.",
  patient_medication_info: "اشرح المعلومات العامة عن الدواء المذكور بشكل تعليمي، مع التنبيه إلى أن الجرعات والملاءمة تعتمد على الوصفة والسياق الطبي ومصدر دوائي موثوق.",
  patient_red_flags: "استخرج علامات الخطر المحتملة من الأعراض المدخلة ووضّح متى يلزم طلب رعاية عاجلة. لا تشخّص.",
  patient_summary: "لخّص الأعراض المدخلة بلغة واضحة ومنظمة للمريض أو لمشاركته مع المختص.",
  patient_first_aid: "قدّم إرشادات إسعاف أولي عامة وآمنة للحالة الموصوفة، مع ذكر متى يجب طلب الطوارئ. لا تقدّم تعليمات خطرة أو بديلًا عن الرعاية الطبية.",
  pharmacist_drug_review: "نظّم مراجعة الدواء من البيانات المدخلة، وميّز بين المعلومات المؤكدة وما يحتاج تحققًا من مرجع دوائي موثوق.",
  pharmacist_alternatives: "نظّم البحث عن بدائل بحسب المادة الفعالة مع التأكيد على مطابقة التركيز والشكل وطريق الإعطاء والحساسية والبلد، ولا تعتمد بديلًا تلقائيًا.",
  pharmacist_interactions: "حلّل قائمة الأدوية بحثًا عن تداخلات محتملة، مع اعتبار النتيجة للمراجعة وليس مرجعًا دوائيًا نهائيًا.",
  pharmacist_dose_review: "نظّم مراجعة الجرعة من البيانات المدخلة، ولا تخمّن جرعة ناقصة؛ اطلب الرجوع إلى مرجع دوائي موثوق ووصفة الطبيب."
};

function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    ...headers
  });
  res.end(body);
}

function clientIp(req) {
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
    .toString().split(",")[0].trim();
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

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = "";
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (_) { reject(Object.assign(new Error("Invalid JSON"), { statusCode: 400 })); }
    });
    req.on("error", reject);
  });
}

function buildPrompt(task, data, language) {
  const lang = language === "en" ? "English" : "Arabic";
  const instruction = TASK_INSTRUCTIONS[task] || "حلّل البيانات بشكل منظم وآمن، دون ادعاء تشخيص نهائي.";
  return [
    "أنت مساعد صحي رقمي داخل تطبيق Smart Nabd.",
    "المخرجات تعليمية/تنظيمية وداعمة للمختص أو المستخدم وليست تشخيصًا طبيًا نهائيًا ولا بديلًا عن الطبيب أو الصيدلاني أو بروتوكولات المؤسسة.",
    "لا تخترع بيانات غير موجودة. إذا كانت معلومات أساسية ناقصة فاذكر ذلك بوضوح.",
    "إذا ظهرت مؤشرات طارئة في البيانات، اجعل التنبيه لطلب رعاية عاجلة واضحًا.",
    `المهمة: ${instruction}`,
    `لغة الإجابة: ${lang}.`,
    "بيانات الحالة بصيغة JSON:",
    JSON.stringify(data ?? {}, null, 2)
  ].join("\n\n");
}

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) {
    const err = new Error("GEMINI_API_KEY غير مهيأ على الخادم.");
    err.statusCode = 503;
    throw err;
  }

  const model = /^[a-zA-Z0-9._-]+$/.test(GEMINI_MODEL) ? GEMINI_MODEL : "gemini-3.6-flash";
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }]
      }),
      signal: controller.signal
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error?.message || "Gemini API request failed.";
      const err = new Error(message);
      err.statusCode = response.status === 429 ? 429 : 502;
      throw err;
    }

    const text = (payload?.candidates || [])
      .flatMap(c => c?.content?.parts || [])
      .map(p => p?.text || "")
      .join("")
      .trim();

    if (!text) {
      const err = new Error("Gemini returned an empty response.");
      err.statusCode = 502;
      throw err;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, {
      ok: true,
      aiConfigured: Boolean(GEMINI_API_KEY),
      model: GEMINI_MODEL
    });
  }

  if (req.method === "POST" && url.pathname === "/api/gemini/analyze") {
    if (!rateAllowed(req)) {
      return send(res, 429, { error: "تم تجاوز حد الطلبات مؤقتًا. حاول بعد دقيقة." });
    }

    try {
      const body = await readJson(req);
      const task = String(body.task || "");
      if (!task) return send(res, 400, { error: "Missing task." });

      const prompt = buildPrompt(task, body.data || {}, body.language);
      const text = await callGemini(prompt);
      return send(res, 200, { text, model: GEMINI_MODEL });
    } catch (error) {
      const status = error.statusCode || 500;
      const publicMessage =
        status === 503 ? "الذكاء الاصطناعي غير مهيأ على الخادم بعد." :
        status === 429 ? "تم تجاوز حد الطلبات من Gemini مؤقتًا. حاول لاحقًا." :
        status === 413 ? "البيانات المرسلة كبيرة جدًا." :
        "تعذر تنفيذ طلب الذكاء الاصطناعي حاليًا.";
      console.error("[Gemini]", error.message);
      return send(res, status, { error: publicMessage });
    }
  }

  // Serve the existing single-page app.
  if (req.method === "GET") {
    let filePath = path.join(__dirname, url.pathname === "/" ? "index.html" : url.pathname);
    if (!filePath.startsWith(__dirname) || filePath.includes("..")) {
      return send(res, 404, { error: "Not found" });
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const types = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml"
      };
      res.writeHead(200, {
        "Content-Type": types[ext] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "Referrer-Policy": "strict-origin-when-cross-origin"
      });
      return fs.createReadStream(filePath).pipe(res);
    }
  }

  return send(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  router(req, res).catch(error => {
    console.error("[Server]", error);
    if (!res.headersSent) send(res, 500, { error: "Internal server error." });
  });
});

server.listen(PORT, () => {
  console.log(`Smart Nabd running on http://localhost:${PORT}`);
  console.log(`Gemini model: ${GEMINI_MODEL}`);
  console.log(`Gemini key configured: ${Boolean(GEMINI_API_KEY)}`);
});
