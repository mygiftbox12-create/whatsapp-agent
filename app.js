const express = require('express');
const { Pool } = require('pg');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "myshirt2025";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OWNER_PHONE = process.env.OWNER_PHONE || "972543184416";
const DATABASE_URL = process.env.DATABASE_URL;
const TRANSCRIPTS_PASSWORD = process.env.TRANSCRIPTS_PASSWORD || "mygift2025";

// ===== PostgreSQL connection =====
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : false
});

// ===== Deterministic size calculation (oversized fit) =====
// Validated anchor points: height (m) -> base size at "average" weight for that height.
// Height is the PRIMARY driver (garment length), weight only nudges the size up/down within that.
const SIZES_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];

// height -> [baseSize, averageWeightKg] - confirmed by the store owner
const HEIGHT_ANCHORS = [
  [1.50, 'XS', 52],
  [1.55, 'XS', 55],
  [1.60, 'S', 60],
  [1.65, 'S', 63],
  [1.70, 'M', 67],
  [1.75, 'M', 71],   // borderline M/L - weight nudge handles it naturally
  [1.80, 'L', 75],
  [1.85, 'XL', 80],
  [1.90, 'XXL', 85],
  [1.95, '3XL', 90],
];

const WEIGHT_STEP_KG = 12; // each ~12kg above/below the average for that height shifts one size

function interpolateAnchor(height) {
  // Find the two nearest anchors and interpolate baseSize index + averageWeight
  if (height <= HEIGHT_ANCHORS[0][0]) {
    const [, size, avgW] = HEIGHT_ANCHORS[0];
    return { sizeIdx: SIZES_ORDER.indexOf(size), avgWeight: avgW };
  }
  if (height >= HEIGHT_ANCHORS[HEIGHT_ANCHORS.length - 1][0]) {
    const [, size, avgW] = HEIGHT_ANCHORS[HEIGHT_ANCHORS.length - 1];
    return { sizeIdx: SIZES_ORDER.indexOf(size), avgWeight: avgW };
  }
  for (let i = 0; i < HEIGHT_ANCHORS.length - 1; i++) {
    const [h1, size1, w1] = HEIGHT_ANCHORS[i];
    const [h2, size2, w2] = HEIGHT_ANCHORS[i + 1];
    if (height >= h1 && height <= h2) {
      const ratio = (height - h1) / (h2 - h1);
      const idx1 = SIZES_ORDER.indexOf(size1);
      const idx2 = SIZES_ORDER.indexOf(size2);
      const sizeIdx = idx1 + (idx2 - idx1) * ratio;
      const avgWeight = w1 + (w2 - w1) * ratio;
      return { sizeIdx, avgWeight };
    }
  }
  // fallback (shouldn't reach here)
  const [, size, avgW] = HEIGHT_ANCHORS[Math.floor(HEIGHT_ANCHORS.length / 2)];
  return { sizeIdx: SIZES_ORDER.indexOf(size), avgWeight: avgW };
}

// Returns { oversized, fitted } for given height (meters) and weight (kg)
// Special rules for tall heights override the general interpolation.
function calculateSize(heightM, weightKg) {
  // 1.87m–1.95m special rule
  if (heightM >= 1.87 && heightM <= 1.95) {
    if (weightKg <= 80)  return { oversized: 'XL',  fitted: 'L'   };
    if (weightKg <= 95)  return { oversized: 'XXL', fitted: 'XL'  };
    if (weightKg <= 120) return { oversized: '3XL', fitted: 'XXL' };
    return { oversized: 'ESCALATE', fitted: 'ESCALATE' };
  }

  // 1.83m–1.86m special rule
  if (heightM >= 1.83 && heightM < 1.87) {
    if (weightKg <= 90)  return { oversized: 'XL',  fitted: 'L'   };
    if (weightKg <= 115) return { oversized: 'XXL', fitted: 'XL'  };
    if (weightKg <= 130) return { oversized: '3XL', fitted: 'XXL' };
    return { oversized: 'ESCALATE', fitted: 'ESCALATE' };
  }

  // General interpolation for heights up to ~1.82m
  const { sizeIdx, avgWeight } = interpolateAnchor(heightM);
  const diff = weightKg - avgWeight;
  const shift = Math.round(diff / WEIGHT_STEP_KG);
  const rawIdx = Math.round(sizeIdx) + shift;
  const clampedIdx = Math.max(0, Math.min(SIZES_ORDER.length - 1, rawIdx));
  const oversizedSize = SIZES_ORDER[clampedIdx];
  const fittedIdx = Math.max(0, clampedIdx - 1);
  const fittedSize = SIZES_ORDER[fittedIdx];
  return { oversized: oversizedSize, fitted: fittedSize };
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_escalations (
      phone TEXT PRIMARY KEY,
      last_message TEXT,
      description TEXT,
      escalated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversation_log (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS live_updates (
      id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stats (
      key TEXT PRIMARY KEY,
      value BIGINT DEFAULT 0
    );
  `);
  // Deduplication table: prevents processing the same message twice
  // (happens with Click-to-WhatsApp ads that sometimes fire the webhook twice)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id TEXT PRIMARY KEY,
      processed_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Auto-cleanup: delete dedup records older than 24 hours (they're only needed briefly)
  await pool.query(`
    DELETE FROM processed_messages WHERE processed_at < now() - interval '24 hours';
  `);
  await pool.query(`
    INSERT INTO stats (key, value) VALUES ('total_messages', 0), ('total_escalations', 0)
    ON CONFLICT (key) DO NOTHING;
  `);
  console.log('Database initialized.');
}

// ===== DB helper functions =====

async function incrementStat(key) {
  const res = await pool.query(
    `UPDATE stats SET value = value + 1 WHERE key = $1 RETURNING value`,
    [key]
  );
  return res.rows[0]?.value || 0;
}

async function getStat(key) {
  const res = await pool.query(`SELECT value FROM stats WHERE key = $1`, [key]);
  return res.rows[0]?.value || 0;
}

async function getConversationHistory(phone, limit = 10) {
  const res = await pool.query(
    `SELECT role, content FROM conversation_log WHERE phone = $1 ORDER BY id DESC LIMIT $2`,
    [phone, limit]
  );
  return res.rows.reverse().map(r => ({ role: r.role, content: r.content }));
}

async function appendConversation(phone, role, content) {
  await pool.query(
    `INSERT INTO conversation_log (phone, role, content) VALUES ($1, $2, $3)`,
    [phone, role, content]
  );
}

// List distinct customers with optional search by phone or message content
async function getCustomerConversationSummaries(search = '') {
  const searchParam = search ? `%${search}%` : null;
  const res = searchParam
    ? await pool.query(
        `SELECT phone,
                MAX(created_at) AS last_activity,
                (ARRAY_AGG(content ORDER BY id DESC))[1] AS last_message,
                COUNT(*) AS message_count
         FROM conversation_log
         WHERE phone != $1
           AND (phone ILIKE $2 OR content ILIKE $2)
         GROUP BY phone
         ORDER BY last_activity DESC`,
        [OWNER_PHONE, searchParam]
      )
    : await pool.query(
        `SELECT phone,
                MAX(created_at) AS last_activity,
                (ARRAY_AGG(content ORDER BY id DESC))[1] AS last_message,
                COUNT(*) AS message_count
         FROM conversation_log
         WHERE phone != $1
         GROUP BY phone
         ORDER BY last_activity DESC`,
        [OWNER_PHONE]
      );
  return res.rows;
}

// Full transcript for a single phone number, in chronological order
async function getFullTranscript(phone) {
  const res = await pool.query(
    `SELECT role, content, created_at FROM conversation_log WHERE phone = $1 ORDER BY id ASC`,
    [phone]
  );
  return res.rows;
}

async function setPendingEscalation(phone, lastMessage, description) {
  await pool.query(
    `INSERT INTO pending_escalations (phone, last_message, description, escalated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (phone) DO UPDATE SET last_message = $2, description = $3, escalated_at = now()`,
    [phone, lastMessage, description]
  );
}

async function getPendingEscalations() {
  const res = await pool.query(
    `SELECT phone, last_message, description, escalated_at FROM pending_escalations ORDER BY escalated_at ASC`
  );
  return res.rows;
}

async function getPendingEscalationByExactPhone(phone) {
  const res = await pool.query(
    `SELECT phone, last_message, description FROM pending_escalations WHERE phone = $1`,
    [phone]
  );
  return res.rows[0] || null;
}

async function findPendingEscalationByPhone(targetPhoneDigits) {
  const res = await pool.query(`SELECT phone FROM pending_escalations`);
  for (const row of res.rows) {
    const rowDigits = normalizePhone(row.phone);
    if (rowDigits === targetPhoneDigits || rowDigits.endsWith(targetPhoneDigits)) {
      return row.phone;
    }
  }
  return null;
}

async function deletePendingEscalation(phone) {
  await pool.query(`DELETE FROM pending_escalations WHERE phone = $1`, [phone]);
}

async function addLiveUpdate(content) {
  await pool.query(`INSERT INTO live_updates (content) VALUES ($1)`, [content]);
}

async function getLiveUpdates() {
  const res = await pool.query(`SELECT id, content FROM live_updates ORDER BY id ASC`);
  return res.rows;
}

async function clearLiveUpdates() {
  await pool.query(`DELETE FROM live_updates`);
}

// ===== System prompt =====

const BASE_SYSTEM_PROMPT = `אתה סוכן שירות לקוחות מקצועי ואדיב של חנות חולצות ציצית מהודרות ואופנתיות בשם My Gift.
ענה תמיד בעברית בלבד, בצורה חמה, ידידותית ומקצועית.
חשוב מאוד: אל תשנה שפה גם אם הלקוח כתב בשפה אחרת — המשך בעברית. רק אם הלקוח מבקש במפורש לדבר בשפה אחרת ("please answer in English" / "ענה לי באנגלית" וכדומה) — אפשר לעבור לאותה שפה ולהישאר בה לאורך כל השיחה. לעולם אל תערבב שפות בתשובה אחת.

איחולים לפי יום בשבוע:
- "שבת שלום" / "שבת טוב" — מתאים רק מיום חמישי ואילך (חמישי, שישי, שבת). אל תכתוב איחול שכזה ביום ראשון, שני, שלישי או רביעי — זה לא מדויק ולא מקצועי.
- ביום ראשון לאחר שבת — אפשר "שבוע טוב" במידה ומתאים לשיחה, אבל לא חובה.

מידע על המוצרים והמחירים:
- חולצת ציצית מהודרת ואופנתית — 250 ₪ ליחידה
- 2 חולצות — 450 ₪
- 3 חולצות — 600 ₪
- 4 חולצות ומעלה — 200 ₪ ליחידה

סוג הבד:
- החולצות עשויות כותנה איכותית
- אם הלקוח שואל שאלות מפורטות יותר על הבד (אחוזי כותנה, עובי, תחושה מדויקת, טיפול בכביסה וכו') שאין לך תשובה עליהן — כתוב [ESCALATE: לקוח שואל על פרטי הבד: X]

סוג הקשירה:
- החולצות מגיעות עם פתיל עבה בקשירה ספרדית מהודרת - מניין טל
- אם הלקוח שואל שאלות נוספות על הקשירה שאין לך תשובה עליהן — כתוב [ESCALATE: לקוח שואל על פרטי הקשירה: X]

צבעים זמינים לחולצה בודדת:
שחור, לבן, שמנת, אפור, כחול נייבי, אבן, חום כהה, חום בהיר

סטים (חולצת ציצית + מכנס תואם):
- סט אחד (חולצה + מכנס) — 400 ₪
- 2 סטים — 700 ₪ (סה"כ לשניהם)
- צבעים זמינים לסט: שחור, לבן, חום בהיר, כחול נייבי, חום כהה
- אם לקוח מתעניין בסט, ודא שהוא מבין שזה כולל חולצה ומכנס יחד (לא רק חולצה)

מידות - חשוב מאוד, קרא בעיון:
החולצות הן אוברסייז. כדי לחשב את המידה המומלצת, אסור לך לחשב בעצמך לפי הערכה - יש מערכת מדויקת שעושה את זה.
כשהלקוח שולח גובה ומשקל, כתוב בתשובה שלך תג בפורמט הזה (במקום לנחש מידה בעצמך):
[SIZE_CALC: height=1.75 weight=86]
(height במטרים עם נקודה עשרית, weight בק"ג, מספרים בלבד)

המערכת תחשב את המידה המדויקת ותחזיר לך אותה לפני שתשלח את התשובה הסופית ללקוח - כך שתוכל לנסח תשובה טבעית עם המידה הנכונה.
אל תכתוב בעצמך איזו מידה אתה חושב שמתאימה - תמיד תן למערכת לחשב, אפילו אם אתה "בטוח" שאתה יודע את התשובה.
אם הלקוח כבר נתן גובה ומשקל בהודעה קודמת בשיחה ושאל שאלת המשך, אפשר להשתמש בתג שוב עם אותם נתונים כדי לקבל את המידה המדויקת מחדש - אל תסתמך על זיכרון של תשובה קודמת.
אם הלקוח אומר שהוא מעדיף לבישה צמודה יחסית ולא רוצה אוברסייז - המערכת תחזיר לך גם את המידה ל"צמוד" וגם ל"אוברסייז", תבחר את המתאימה.
אם הנתונים שהלקוח שלח לא הגיוניים בעליל (גובה/משקל לא אפשריים) — כתוב [ESCALATE: לקוח עם מידות לא סטנדרטיות, גובה X משקל Y]
אם המידה שמחזירה המערכת היא [ESCALATE] עקב מידות מחוץ לטווח (משקל מעל 140 ק"ג או גובה מעל 1.95 מטר) — אמור ללקוח שאתה בודק עם המנהל אם המידה הגדולה ביותר שלנו (3XL) תתאים לו, ואל תתן המלצת מידה עצמאית

תהליך הזמנה בוואטסאפ:
1. בקש מהלקוח לשלוח גובה ומשקל להתאמת מידה (אם לא יודע את מידתו)
2. בקש צבע/צבעים רצויים
3. הצג סיכום הזמנה עם מחיר סופי כולל משלוח
4. שאל באיזו דרך תשלום הוא מעדיף

משלוח:
- עלות משלוח עד הבית — 35 ₪
- זמן אספקה — עד 7 ימי עסקים (בדרך כלל מגיע תוך 5 ימים)

איסוף עצמי:
- המחסן ממוקם בישוב צופים (ליד כפר סבא)
- איסוף עצמי אפשרי בתיאום מראש בלבד
- לתיאום הגעה: 0543184416

שעות פעילות:
- ראשון עד חמישי — 09:00 עד 18:00

אפשרויות תשלום:
- ביט / פייבוקס — העבר למספר 0543184416, שלח צילום מסך של אישור ההעברה
- העברה בנקאית:
  שם המוטב: נתנאל ליכטנברג
  בנק: מזרחי טפחות
  סניף: 441
  מספר חשבון: 136545
  לאחר ההעברה — שלח צילום מסך
- אשראי טלפוני — התקשר ל-0543184416 בשעות הפעילות
- אשראי באתר: https://mygiftbox.co.il/מארזי-מתנה-לגבר/חולצות-ציצית/

תהליך סגירת הזמנה - שים לב לסדר המדויק, זה חשוב:

אם הלקוח משלם באשראי באתר, או באשראי טלפוני:
- אל תבקש ממנו שם/כתובת/טלפון! הפרטים האלה יוזנו ישירות באתר (בתשלום אשראי באתר) או ע"י הנציג בטלפון (באשראי טלפוני). אל תשלח [ORDER_COMPLETE] במקרה הזה - הבעלים רואה את ההזמנה בממשק האתר.

אם הלקוח משלם בביט / פייבוקס / העברה בנקאית - בשני שלבים בסדר הזה:
1. בקש ממנו לשלוח צילום מסך של אישור ההעברה. אל תבקש פרטי משלוח עדיין!
2. רק אחרי שהלקוח שלח צילום מסך (תמונה) - בקש ממנו שם מלא, כתובת מלאה (כולל עיר) וטלפון למשלוח
3. רק אחרי שיש גם צילום מסך וגם פרטי משלוח מלאים - כתוב בתשובתך תג [ORDER_COMPLETE: סיכום ההזמנה] עם כל הפרטים (מוצרים שהוזמנו, צבעים, מידות, כמות, מחיר סופי, אמצעי תשלום, שם הלקוח, כתובת, טלפון)

אם הלקוח משלם במזומן (אחרי שהבעלים אישר לך את זה בהודעה רגילה בשיחה) - בשני שלבים:
1. בקש ממנו שם מלא, כתובת מלאה וטלפון למשלוח
2. רק אחרי שיש פרטי משלוח מלאים - כתוב בתשובתך תג [ORDER_COMPLETE: סיכום ההזמנה] עם כל הפרטים (כמו לעיל, אמצעי תשלום: מזומן)

פורמט תג ה-ORDER_COMPLETE: כתוב סיכום מלא וברור בתוך התג עצמו, למשל:
[ORDER_COMPLETE: 2 חולצות בצבע שחור ולבן, מידה L, 450 ₪ + 35 ₪ משלוח. תשלום: ביט. לקוח: יוסי כהן, רחוב הרצל 5 תל אביב, טלפון 0501234567]
התג הזה לא מוצג ללקוח - הוא נשלח אוטומטית לבעלים. תוכל בנוסף לכתוב הודעת סיום רגילה ללקוח (כמו "תודה! ההזמנה נקלטה, נשלח אליך בקרוב").

החזרות והחלפות:
- ניתן להחזיר/להחליף באמצעות שליחויות או הגעה פיזית למחסן בצופים בתיאום מראש
- אם לקוח חושש לגבי מידה — הרגע אותו: אנחנו מתאימים מידות באופן מדויק מאוד
- אם יש טעות במידה — מבצעים החלפה באמצעות שליח וטיפול מלא מצדנו
- המטרה שלנו היא שכל לקוח יהיה מרוצה 100%

תמונות:
- אם לקוח מבקש לראות איך נראית חולצה בודדת, או מבקש לראות צבע מסוים, אתה יכול לשלוח לו תמונה
- כדי לשלוח תמונה של חולצה בודדת, כתוב בתשובה שלך תג בפורמט: [IMAGE: שם_הצבע] (שם הצבע באנגלית, אחד מהבאים: black, white, gray, stone, brown, lightbrown, multicolor)
- "multicolor" משמש כשהלקוח מבקש לראות את כל הצבעים יחד / קולקציה כללית
- כדי לשלוח תמונה של סט (חולצה + מכנס), כתוב תג בפורמט: [IMAGE: set-שם_הצבע] - הצבעים הזמינים לסט: set-black, set-white, set-lightbrown, set-navy, set-brown
- אל תשתמש בתג של סט עבור חולצה בודדת ולהיפך - אלו תמונות שונות
- חשוב: אין תמונה של חולצה בודדת בצבע "כחול נייבי" - יש רק תמונה של הסט בנייבי. אם לקוח מבקש לראות חולצה בודדת בנייבי, הסבר לו שאין כרגע תמונה מצולמת של חולצה בודדת בצבע הזה, אבל אפשר להראות לו את הסט בנייבי [IMAGE: set-navy] לקבלת מושג על הצבע
- ניתן לשלב כמה תגי תמונה בתשובה אחת אם הלקוח מבקש כמה צבעים
- לצבע "שמנת" אין כרגע תמונה מצולמת (לא לחולצה בודדת ולא לסט) - אם מתבקש, הסבר שאין דגם מצולם של הצבע הזה כרגע אבל הוא קיים במלאי
- שלב את תג התמונה בטבעיות בתוך הטקסט, למשל: "בטח! הנה איך נראית בשחור [IMAGE: black] יפה מאוד, נכון?"

כללי התנהגות:
- ענה בצורה קצרה וברורה
- אם לקוח מתעניין — נסה לסגור מכירה בצורה טבעית ולא דוחפנית
- בסוף כל שיחת מכירה — שלח את קישור האתר לרכישה
- אל תמציא מידע שלא ניתן לך — זה הכלל החשוב ביותר! אם שואלים אותך שאלה על המוצר ואין לך תשובה ברורה במידע שניתן לך, תמיד כתוב [ESCALATE: X] ואל תנחש. עדיף להגיד "אני בודק עם מנהל" מאשר לתת תשובה לא נכונה

מתי לעצור ולהעביר לבעלים (escalation) - אלה החריגים שדורשים אישור אנושי:
- בקשות תשלום לא סטנדרטיות (הנחה, תנאי תשלום מיוחדים)
- בקשות איסוף/משלוח לא רגילות (איסוף עצמי שלא בשעות הרגילות, משלוח לאזור מרוחק, בקשה שהבעלים יגיע אישית)
- כל בקשה לתנאים מיוחדים, הנחות, או חריגות ממה שכתוב במידע שניתן לך
- שאלה שאין לך תשובה עליה מהמידע שניתן לך
- כל מקרה שמרגיש לא שגרתי או רגיש (תלונה, בעיה במוצר שהתקבל, בקשה חריגה)

תשלום במזומן - תהליך מיוחד בשני שלבים (אל תסלים ישר!):
- אם לקוח שואל אם אפשר לשלם במזומן, אל תפעיל [ESCALATE] עדיין - שאל אותו קודם מאיפה הוא (איזה עיר/אזור), כדי לבדוק אם זה מתאים ללו"ז
- רק כשהלקוח עונה ונותן את המיקום שלו, אז תפעיל [ESCALATE] עם כל הפרטים: המיקום שהלקוח נתן, ושאר פרטי ההזמנה אם יש
- לדוגמה: לקוח שואל "אפשר לשלם מזומן?" -> תשובתך: "בטח, מאיפה אתה? אבדוק אם זה מסתדר" (בלי ESCALATE)
- לקוח עונה "אני מתל אביב" -> תשובתך: [ESCALATE: לקוח רוצה לשלם במזומן, נמצא בתל אביב, צריך לבדוק אם זה מתאים ללו"ז ולתאם הגעה]
- אם הבעלים מאשר את התשלום במזומן (תקבל את האישור כהודעה רגילה בשיחה) - זכור לבקש מהלקוח שם מלא, כתובת מלאה וטלפון למשלוח, בדיוק כמו בשאר אמצעי התשלום שדורשים את זה

כשאתה מחליט להסלים, כתוב בפורמט הזה (כדי שהבעלים יידע בדיוק על מה השאלה):
[ESCALATE: תיאור קצר של מה הלקוח מבקש/שואל]

לדוגמה:
- לקוח שואל על הנחה לכמות גדולה → [ESCALATE: לקוח מבקש הנחה על הזמנה של 10 חולצות]

לגבי בקשות חריגות - אל תגיד ללקוח "אין אפשרות" או "לא ניתן" בעצמך. במקום זה תגיד שאתה בודק ותחזור אליו, ותפעיל [ESCALATE].`;

async function buildSystemPrompt(isFirstMessage = false) {
  const updates = await getLiveUpdates();
  let prompt = BASE_SYSTEM_PROMPT;

  if (isFirstMessage) {
    prompt += `\n\nהערה לתשובה הזו בלבד: זו ההודעה הראשונה של הלקוח הזה אי פעם.
המערכת כבר שולחת לפניך אוטומטית הודעת פתיחה קבועה: "היי מה שלומך, התעניינת בחולצות ציצית? שולח פרטים 😊" - אל תכתוב אתה הודעת פתיחה/ברכה דומה, התשובה שלך היא ההודעה הבאה אחריה.
כתוב כעת תשובה קצרה שמתמקדת במחירי החולצות הבודדות בלבד (250/450/600/200 ליחידה מ-4 ומעלה) - אל תזכיר סטים בשלב הזה אלא אם הלקוח שאל על מכנסיים/סט במפורש.
אחרי שתשלח את התשובה הזו, המערכת תשלח אוטומטית (לא אתה) רצף קבוע: תמונות של כל הצבעים (חולצות וסטים), ואז הודעת טקסט עם רשימת הצבעים הזמינים, ואז תמונת הקולקציה הכללית. אל תכתוב בעצמך תגי [IMAGE] בתשובה הזו ואל תפרט את רשימת הצבעים בעצמך - זה כבר יישלח אוטומטית אחריך.`;
  } else {
    prompt += `\n\nהערה לתשובה הזו בלבד: זו לא ההודעה הראשונה של הלקוח הזה - המערכת לא תשלח תמונות פתיחה אוטומטיות הפעם. אל תגיד ללקוח שאתה "שולח תמונות" אלא אם כן אתה בעצמך כותב תג [IMAGE: ...] בתשובה שלך.`;
  }

  if (updates.length > 0) {
    prompt += `\n\nעדכונים חדשים מהבעלים (מידע עדכני - תמיד תעדיף אותו על פני המידע שמעליו אם יש סתירה):\n${updates.map((u, i) => `${i + 1}. ${u.content}`).join('\n')}`;
  }

  return prompt;
}

// ===== WhatsApp send helper =====

// ===== Product images =====
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/mygiftbox12-create/whatsapp-agent/main/images';
const COLOR_IMAGE_MAP = {
  black: `${GITHUB_RAW_BASE}/shirt-black.jpeg`,
  white: `${GITHUB_RAW_BASE}/shirt-white.jpeg`,
  gray: `${GITHUB_RAW_BASE}/shirt-gray.jpeg`,
  stone: `${GITHUB_RAW_BASE}/shirt-stone.jpeg`,
  brown: `${GITHUB_RAW_BASE}/shirt-brown.jpeg`,
  lightbrown: `${GITHUB_RAW_BASE}/shirt-lightbrown.jpeg`,
  multicolor: `${GITHUB_RAW_BASE}/shirt-multicolor.jpeg`
  // Note: no individual-shirt photo exists for "navy" - only the set photo (set-navy) exists.
};

// Set product images (shirt + matching pants), separate from individual shirt images
const SET_IMAGE_MAP = {
  'set-black': `${GITHUB_RAW_BASE}/set-black.jpeg`,
  'set-white': `${GITHUB_RAW_BASE}/set-white.jpeg`,
  'set-lightbrown': `${GITHUB_RAW_BASE}/set-lightbrown.jpeg`,
  'set-navy': `${GITHUB_RAW_BASE}/set-navy.jpeg`,
  'set-brown': `${GITHUB_RAW_BASE}/set-brown.jpeg`
};
// Merge into one lookup table used by extractImageTags/sendReplyWithImages
const ALL_IMAGE_MAP = { ...COLOR_IMAGE_MAP, ...SET_IMAGE_MAP };

// Full gallery sent automatically on a new conversation: every individual shirt color + every set color
// (multicolor is sent separately, at the very end, after the colors text message)
const WELCOME_GALLERY_URLS = [
  `${GITHUB_RAW_BASE}/shirt-black.jpeg`,
  `${GITHUB_RAW_BASE}/shirt-white.jpeg`,
  `${GITHUB_RAW_BASE}/shirt-gray.jpeg`,
  `${GITHUB_RAW_BASE}/shirt-stone.jpeg`,
  `${GITHUB_RAW_BASE}/shirt-brown.jpeg`,
  `${GITHUB_RAW_BASE}/shirt-lightbrown.jpeg`,
  `${GITHUB_RAW_BASE}/set-black.jpeg`,
  `${GITHUB_RAW_BASE}/set-white.jpeg`,
  `${GITHUB_RAW_BASE}/set-lightbrown.jpeg`,
  `${GITHUB_RAW_BASE}/set-navy.jpeg`,
  `${GITHUB_RAW_BASE}/set-brown.jpeg`
];
const WELCOME_MULTICOLOR_URL = `${GITHUB_RAW_BASE}/shirt-multicolor.jpeg`;

const WELCOME_COLORS_TEXT = `צבעים זמינים:
שחור, לבן, שמנת, אפור, כחול נייבי, אבן, חום כהה, חום בהיר

זמין לכל שאלה 🙏`;

async function sendWhatsAppImage(to, imageUrl, caption = '') {
  try {
    const res = await fetch(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'image',
        image: { link: imageUrl, caption: caption }
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('WhatsApp image send error:', res.status, errText);
    }
  } catch (e) {
    console.error('WhatsApp image send exception:', e);
  }
}

async function sendWhatsAppMessage(to, text) {
  try {
    const res = await fetch(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        text: { body: text }
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('WhatsApp send error:', res.status, errText);
    }
  } catch (e) {
    console.error('WhatsApp send exception:', e);
  }
}

function normalizePhone(p) {
  return (p || '').replace(/\D/g, '');
}

// Extract [IMAGE: color] tags, return { cleanText, colors }
function extractImageTags(text) {
  const colors = [];
  const cleanText = text.replace(/\[IMAGE:\s*([a-zA-Z-]+)\s*\]/g, (match, color) => {
    colors.push(color.toLowerCase().trim());
    return '';
  }).replace(/[ \t]+\n/g, '\n').trim();
  return { cleanText, colors };
}

async function sendReplyWithImages(to, replyText) {
  const { cleanText, colors } = extractImageTags(replyText);
  if (cleanText) {
    await sendWhatsAppMessage(to, cleanText);
  }
  for (const color of colors) {
    const url = ALL_IMAGE_MAP[color];
    if (url) {
      await sendWhatsAppImage(to, url);
    } else {
      console.error(`No image mapped for color: ${color}`);
    }
  }
}

const OWNER_PHONE_NORMALIZED = normalizePhone(OWNER_PHONE);

// ===== Owner command handlers =====

async function handleOwnerCommand(text) {
  const trimmed = text.trim();

  // /status
  if (trimmed === '/status' || trimmed === '/סטטוס') {
    const totalMessages = await getStat('total_messages');
    const totalEscalations = await getStat('total_escalations');
    const openEscalations = await getPendingEscalations();
    const updates = await getLiveUpdates();

    let report = `📊 *סטטוס סוכן*\n`;
    report += `💬 הודעות שטופלו (סה"כ): ${totalMessages}\n`;
    report += `⚠️ פניות שהועברו אליך (סה"כ): ${totalEscalations}\n`;
    report += `🔓 פניות פתוחות (ממתינות לתשובה): ${openEscalations.length}\n`;
    if (openEscalations.length > 0) {
      report += `\nרשימת פניות פתוחות:\n`;
      for (const row of openEscalations) {
        report += `• ${row.phone}: "${row.last_message}"\n  📋 ${row.description || 'ללא פירוט'}\n`;
      }
    }
    if (updates.length > 0) {
      report += `\n📝 עדכונים פעילים:\n`;
      updates.forEach((u, i) => { report += `${i + 1}. ${u.content}\n`; });
    }
    await sendWhatsAppMessage(OWNER_PHONE, report);
    return true;
  }

  // /update <text>
  if (trimmed.startsWith('/update ') || trimmed.startsWith('/עדכון ')) {
    const content = trimmed.replace(/^\/(update|עדכון)\s+/, '').trim();
    if (content) {
      await addLiveUpdate(content);
      await sendWhatsAppMessage(OWNER_PHONE, `✅ נוסף עדכון: "${content}"\nהסוכן ישתמש בזה מעכשיו.`);
    }
    return true;
  }

  // /clearupdates
  if (trimmed === '/clearupdates' || trimmed === '/נקה') {
    await clearLiveUpdates();
    await sendWhatsAppMessage(OWNER_PHONE, '🧹 כל העדכונים נוקו.');
    return true;
  }

  // /reply <phone> <message>
  if (trimmed.startsWith('/reply ') || trimmed.startsWith('/השב ')) {
    const rest = trimmed.replace(/^\/(reply|השב)\s+/, '');
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx === -1) {
      await sendWhatsAppMessage(OWNER_PHONE, '⚠️ פורמט שגוי. שלח: /reply <מספר טלפון> <תשובה>');
      return true;
    }
    const targetPhoneDigits = normalizePhone(rest.slice(0, spaceIdx));
    const replyText = rest.slice(spaceIdx + 1).trim();

    const matchedPhone = await findPendingEscalationByPhone(targetPhoneDigits);

    if (!matchedPhone) {
      await sendWhatsAppMessage(OWNER_PHONE, `⚠️ לא נמצאה פנייה פתוחה ממספר ${rest.slice(0, spaceIdx)}. שלח /status לרשימה.`);
      return true;
    }

    const { cleanText } = extractImageTags(replyText);
    await sendReplyWithImages(matchedPhone, replyText);
    await deletePendingEscalation(matchedPhone);
    await appendConversation(matchedPhone, 'assistant', cleanText || replyText);

    await sendWhatsAppMessage(OWNER_PHONE, `✅ נשלח ללקוח ${matchedPhone}:\n"${replyText}"`);
    return true;
  }

  // /help
  if (trimmed === '/help' || trimmed === '/עזרה') {
    const helpText = `🛠 *פקודות בעלים*\n\n` +
      `/status — תמונת מצב נוכחית (כולל פירוט הפניות הפתוחות)\n` +
      `/update <מידע> — הוסף כלל קבוע שיחול מעכשיו על כל הלקוחות (למשל: "אין מלאי בצבע שחור")\n` +
      `/clearupdates — נקה את כל העדכונים שהוספת\n` +
      `/reply <מספר> <תשובה> — שלח תשובה ידנית ללקוח ספציפי שממתין (חד-פעמי, לא נשמר לעתיד)\n` +
      `/help — הצג רשימה זו\n\n` +
      `💡 הסוכן יעביר אליך אוטומטית כל בקשה חריגה (תשלום במזומן, הנחות, תנאים מיוחדים) עם תיאור קצר של הבקשה.\n` +
      `🗄️ כל המידע נשמר במסד נתונים קבוע ולא נמחק כשהשרת נכבה/מתאפס.`;
    await sendWhatsAppMessage(OWNER_PHONE, helpText);
    return true;
  }

  return false;
}

// ===== Webhook routes =====

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    if (!message) return;

    // Deduplication: skip if we already processed this exact message ID recently
    // (Click-to-WhatsApp ads sometimes fire the webhook twice for the same message)
    const messageId = message.id;
    if (messageId) {
      try {
        await pool.query(
          `INSERT INTO processed_messages (message_id) VALUES ($1)`,
          [messageId]
        );
      } catch (dupErr) {
        // Unique constraint violation = already processed this message, skip it
        console.log(`Duplicate message skipped: ${messageId}`);
        return;
      }
    }

    const from = message.from;

    // Handle non-text message types (voice notes, images, documents, stickers, etc.)
    if (message.type !== 'text') {
      // Don't bother the owner with unsupported message types - just reply to the customer
      if (normalizePhone(from) !== OWNER_PHONE_NORMALIZED) {
        if (message.type === 'audio' || message.type === 'voice') {
          await sendWhatsAppMessage(from, 'אני לא יכול לשמוע הודעות קוליות 🙏 אפשר להקליד בבקשה, או לחייג למספר 0543184416');
        } else {
          await sendWhatsAppMessage(from, 'אני יכול לטפל רק בהודעות טקסט כרגע 🙏 אפשר להקליד בבקשה, או לחייג למספר 0543184416');
        }
      }
      return;
    }

    const text = message.text.body;

    // ===== Is this message from the owner? =====
    if (normalizePhone(from) === OWNER_PHONE_NORMALIZED) {
      const handled = await handleOwnerCommand(text);
      if (handled) return;
      await sendWhatsAppMessage(OWNER_PHONE,
        'קיבלתי 👍 (שלח /help לרשימת פקודות: /status, /update, /reply)');
      return;
    }

    // ===== Regular customer flow =====
    await incrementStat('total_messages');

    const historyBeforeThisMessage = await getConversationHistory(from, 1);
    const isFirstMessageInConversation = historyBeforeThisMessage.length === 0;

    await appendConversation(from, 'user', text);
    const history = await getConversationHistory(from, 10);

    // Check if this customer already has an open escalation waiting on owner reply
    const existingEscalation = await getPendingEscalationByExactPhone(from);

    if (existingEscalation) {
      // Ask Claude to classify: is this new message about the SAME pending topic, or a NEW question?
      const classifyRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 50,
          system: `אתה מסווג הודעות. יש ללקוח פנייה פתוחה שממתינה לתשובת הבעלים, בנושא: "${existingEscalation.description}".
ההודעה האחרונה של הלקוח שלהלן - היא רק תזכורת/בירור על אותו נושא ממתין (כמו "?", "מה קורה", "עדכון?", חזרה על השאלה המקורית), או שאלה/בקשה חדשה ושונה לחלוטין?
ענה במילה אחת בלבד: "SAME" או "NEW".`,
          messages: [{ role: 'user', content: text }]
        })
      });
      const classifyData = await classifyRes.json();
      const classification = (classifyData.content?.[0]?.text || '').trim().toUpperCase();

      if (classification.includes('SAME')) {
        await sendWhatsAppMessage(from, 'הנושא עדיין בבדיקה, נעדכן ממש בקרוב! אם יש שאלות נוספות בינתיים אשמח לעזור 🙂');
        await appendConversation(from, 'assistant', '[הודעת תזכורת - הנושא עדיין ממתין לתשובת הבעלים]');
        return;
      }
      // else: classification is NEW - fall through to normal flow below,
      // the old escalation stays open and the owner can still /reply to it separately.
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: await buildSystemPrompt(isFirstMessageInConversation),
        messages: history
      })
    });

    const claudeData = await claudeRes.json();
    let reply = claudeData.content?.[0]?.text || '[ESCALATE: שגיאה טכנית בסוכן]';

    // ===== Deterministic size calculation =====
    // If Claude requested a size calculation, compute it in code (never trust the LLM's own math)
    // and ask Claude to rewrite its reply using the correct, system-computed size.
    const sizeCalcMatch = reply.match(/\[SIZE_CALC:\s*height=([\d.]+)\s+weight=([\d.]+)\s*\]/);
    if (sizeCalcMatch) {
      const heightM = parseFloat(sizeCalcMatch[1]);
      const weightKg = parseFloat(sizeCalcMatch[2]);

      if (!isNaN(heightM) && !isNaN(weightKg) && heightM > 1.0 && heightM < 2.5 && weightKg > 20 && weightKg < 300) {
        // Global limits: weight > 130kg or height > 1.95m -> always escalate
        // Special height ranges (1.83-1.95) have their own internal limits inside calculateSize
        const exceedsLimit = weightKg > 130 || heightM > 1.95;
        if (exceedsLimit) {
          reply = reply.replace(
            sizeCalcMatch[0],
            `[ESCALATE: לקוח עם מידות מחוץ לטווח המלאי הרגיל — גובה ${heightM}מ' משקל ${weightKg}ק"ג. המידה הגדולה ביותר שלנו היא 3XL, צריך לבדוק אם זה מתאים]`
          );
        } else {
        const { oversized, fitted } = calculateSize(heightM, weightKg);

        // calculateSize may itself return ESCALATE for specific height/weight combos
        if (oversized === 'ESCALATE') {
          reply = reply.replace(
            sizeCalcMatch[0],
            `[ESCALATE: לקוח עם מידות מחוץ לטווח המלאי הרגיל — גובה ${heightM}מ' משקל ${weightKg}ק"ג. המידה הגדולה ביותר שלנו היא 3XL, צריך לבדוק אם זה מתאים]`
          );
        } else {

        const followUpHistory = [
          ...history,
          { role: 'assistant', content: reply },
          {
            role: 'user',
            content: `[תוצאת המערכת] עבור גובה ${heightM} מטר ומשקל ${weightKg} ק"ג: המידה המדויקת היא ${oversized} (ללבישה אוברסייז) או ${fitted} (ללבישה צמודה יותר). כתוב כעת את התשובה הסופית בעברית טבעית ללקוח עם המידה הנכונה הזו בלבד - אל תכתוב שום תג [SIZE_CALC] בתשובה הזו.`
          }
        ];

        const followUpRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 1000,
            system: await buildSystemPrompt(isFirstMessageInConversation),
            messages: followUpHistory
          })
        });
        const followUpData = await followUpRes.json();
        reply = followUpData.content?.[0]?.text || reply;
        } // end else (not ESCALATE from calculateSize)
        } // end else (not exceedsLimit)
      } else {
        // Unrealistic numbers - let the escalate path handle it
        reply = reply.replace(sizeCalcMatch[0], '[ESCALATE: נתוני גובה/משקל לא הגיוניים]');
      }
    }

    const escalateMatch = reply.match(/\[ESCALATE(?::\s*(.+?))?\]/);
    const orderCompleteMatch = reply.match(/\[ORDER_COMPLETE:\s*(.+?)\]/s);

    if (escalateMatch) {
      await incrementStat('total_escalations');
      const description = escalateMatch[1] || 'לא צוין פירוט';
      await setPendingEscalation(from, text, description);

      await sendWhatsAppMessage(from, 'אני בודק עם מנהל - אעדכן בהקדם!');
      await sendWhatsAppMessage(
        OWNER_PHONE,
        `⚠️ *פנייה חדשה דורשת התערבות*\n\n👤 לקוח: ${from}\n💬 הודעה: "${text}"\n📋 סיכום: ${description}\n\nלענות: /reply ${from} <התשובה שלך>\nאם זה כלל קבוע להבא: /update <הכלל>`
      );
    } else {
      if (isFirstMessageInConversation) {
        // Fixed opening greeting - always sent first, exactly the same, before the agent's price reply
        const GREETING_TEXT = 'היי מה שלומך,\nהתעניינת בחולצות ציצית?\nשולח פרטים 😊';
        await sendWhatsAppMessage(from, GREETING_TEXT);
        await appendConversation(from, 'assistant', GREETING_TEXT);
      }

      // Strip [ORDER_COMPLETE: ...] from the customer-facing reply before sending images/text
      let customerFacingReply = reply;
      if (orderCompleteMatch) {
        customerFacingReply = reply.replace(orderCompleteMatch[0], '').replace(/[ \t]+\n/g, '\n').trim();
      }

      const { cleanText } = extractImageTags(customerFacingReply);
      await appendConversation(from, 'assistant', cleanText || customerFacingReply);
      if (customerFacingReply) {
        await sendReplyWithImages(from, customerFacingReply);
      }

      if (orderCompleteMatch) {
        const orderSummary = orderCompleteMatch[1].trim();
        await sendWhatsAppMessage(
          OWNER_PHONE,
          `✅ *הזמנה נסגרה*\n\n👤 לקוח: ${from}\n📦 סיכום: ${orderSummary}`
        );
      }

      if (isFirstMessageInConversation) {
        // Fixed structured sequence: full gallery -> colors text -> multicolor image (last)
        for (const url of WELCOME_GALLERY_URLS) {
          await sendWhatsAppImage(from, url);
        }
        await sendWhatsAppMessage(from, WELCOME_COLORS_TEXT);
        await appendConversation(from, 'assistant', WELCOME_COLORS_TEXT);
        await sendWhatsAppImage(from, WELCOME_MULTICOLOR_URL);
      }
    }
  } catch (e) {
    console.error('Webhook handler error:', e);
  }
});

app.get('/health', (req, res) => res.send('ok'));

// ===== Transcripts viewer (simple password-protected HTML page) =====

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function checkTranscriptsPassword(req, res) {
  const provided = req.query.password || '';
  if (provided !== TRANSCRIPTS_PASSWORD) {
    res.status(401).send(`
      <html dir="rtl" lang="he"><body style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h2>נדרשת סיסמה</h2>
        <form method="get">
          <input type="password" name="password" placeholder="סיסמה" style="padding: 8px; font-size: 16px;" />
          <button type="submit" style="padding: 8px 16px; font-size: 16px;">כניסה</button>
        </form>
      </body></html>
    `);
    return false;
  }
  return true;
}

app.get('/transcripts', async (req, res) => {
  if (!checkTranscriptsPassword(req, res)) return;
  try {
    const search = (req.query.search || '').trim();
    const summaries = await getCustomerConversationSummaries(search);
    const pw = encodeURIComponent(TRANSCRIPTS_PASSWORD);

    const rows = summaries.map(s => {
      const lastMsgPreview = escapeHtml((s.last_message || '').slice(0, 80));
      const lastActivity = new Date(s.last_activity).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
      return `
        <tr>
          <td><a href="/transcripts/${encodeURIComponent(s.phone)}?password=${pw}">${escapeHtml(s.phone)}</a></td>
          <td>${lastActivity}</td>
          <td>${s.message_count}</td>
          <td style="max-width: 350px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${lastMsgPreview}</td>
        </tr>`;
    }).join('');

    res.send(`
      <html dir="rtl" lang="he">
      <head>
        <meta charset="utf-8" />
        <title>שיחות הסוכן - My Gift</title>
        <style>
          body { font-family: sans-serif; padding: 20px; background: #f5f5f5; }
          h1 { color: #333; margin-bottom: 12px; }
          .search-bar { display: flex; gap: 8px; margin-bottom: 16px; }
          .search-bar input { flex: 1; padding: 10px 14px; font-size: 15px; border: 1px solid #ccc; border-radius: 6px; }
          .search-bar button { padding: 10px 20px; background: #25D366; color: white; border: none; border-radius: 6px; font-size: 15px; cursor: pointer; }
          .search-bar a { padding: 10px 14px; color: #666; text-decoration: none; font-size: 14px; align-self: center; }
          table { width: 100%; border-collapse: collapse; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-radius: 8px; overflow: hidden; }
          th, td { padding: 12px; text-align: right; border-bottom: 1px solid #eee; }
          th { background: #25D366; color: white; }
          tr:last-child td { border-bottom: none; }
          tr:hover td { background: #f9f9f9; }
          a { color: #075E54; text-decoration: none; font-weight: bold; }
          .result-count { color: #666; font-size: 14px; margin-bottom: 8px; }
        </style>
      </head>
      <body>
        <h1>📋 שיחות עם לקוחות</h1>
        <form class="search-bar" method="get" action="/transcripts">
          <input type="hidden" name="password" value="${escapeHtml(TRANSCRIPTS_PASSWORD)}" />
          <input type="text" name="search" value="${escapeHtml(search)}" placeholder="חיפוש לפי מספר טלפון או תוכן הודעה..." autofocus />
          <button type="submit">🔍 חפש</button>
          ${search ? `<a href="/transcripts?password=${pw}">✕ נקה</a>` : ''}
        </form>
        <p class="result-count">${search ? `נמצאו ${summaries.length} תוצאות עבור "${escapeHtml(search)}"` : `סה"כ ${summaries.length} שיחות`}</p>
        <table>
          <tr><th>מספר טלפון</th><th>פעילות אחרונה</th><th>הודעות</th><th>הודעה אחרונה</th></tr>
          ${rows || `<tr><td colspan="4" style="text-align:center; color:#999; padding:24px;">${search ? 'לא נמצאו תוצאות' : 'אין שיחות עדיין'}</td></tr>`}
        </table>
      </body>
      </html>
    `);
  } catch (e) {
    console.error('Transcripts list error:', e);
    res.status(500).send('שגיאה בטעינת השיחות');
  }
});

app.get('/transcripts/:phone', async (req, res) => {
  if (!checkTranscriptsPassword(req, res)) return;
  try {
    const phone = req.params.phone;
    const messages = await getFullTranscript(phone);

    const bubbles = messages.map(m => {
      const isCustomer = m.role === 'user';
      const time = new Date(m.created_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
      const align = isCustomer ? 'flex-start' : 'flex-end';
      const bg = isCustomer ? '#fff' : '#DCF8C6';
      return `
        <div style="display: flex; justify-content: ${align}; margin-bottom: 8px;">
          <div style="background: ${bg}; padding: 10px 14px; border-radius: 8px; max-width: 70%; box-shadow: 0 1px 2px rgba(0,0,0,0.1);">
            <div style="white-space: pre-wrap;">${escapeHtml(m.content)}</div>
            <div style="font-size: 11px; color: #888; margin-top: 4px;">${time}</div>
          </div>
        </div>`;
    }).join('');

    res.send(`
      <html dir="rtl" lang="he">
      <head>
        <meta charset="utf-8" />
        <title>שיחה עם ${escapeHtml(phone)}</title>
        <style>
          body { font-family: sans-serif; padding: 20px; background: #ECE5DD; max-width: 800px; margin: 0 auto; }
          h1 { color: #075E54; }
          a.back { display: inline-block; margin-bottom: 16px; color: #075E54; }
        </style>
      </head>
      <body>
        <a class="back" href="/transcripts?password=${encodeURIComponent(TRANSCRIPTS_PASSWORD)}">← חזרה לרשימה</a>
        <h1>שיחה עם ${escapeHtml(phone)}</h1>
        ${bubbles || '<p>אין הודעות</p>'}
      </body>
      </html>
    `);
  } catch (e) {
    console.error('Transcript detail error:', e);
    res.status(500).send('שגיאה בטעינת השיחה');
  }
});

initDb()
  .then(() => {
    app.listen(3000, () => console.log('Server running on port 3000, DB initialized.'));
  })
  .catch(err => {
    console.error('Failed to initialize DB:', err);
    process.exit(1);
  });
