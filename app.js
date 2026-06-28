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

// ===== PostgreSQL connection =====
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : false
});

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
ענה תמיד בעברית, בצורה חמה, ידידותית ומקצועית.

מידע על המוצרים והמחירים:
- חולצת ציצית מהודרת ואופנתית — 250 ₪ ליחידה
- 2 חולצות — 450 ₪
- 3 חולצות — 600 ₪
- 4 חולצות ומעלה — 200 ₪ ליחידה

צבעים זמינים לחולצה בודדת:
שחור, לבן, שמנת, אפור, כחול נייבי, אבן, חום כהה, חום בהיר

סטים (חולצת ציצית + מכנס תואם):
- סט אחד (חולצה + מכנס) — 400 ₪
- 2 סטים — 700 ₪ (סה"כ לשניהם)
- צבעים זמינים לסט: שחור, לבן, חום בהיר, כחול נייבי, חום כהה
- אם לקוח מתעניין בסט, ודא שהוא מבין שזה כולל חולצה ומכנס יחד (לא רק חולצה)

מידות וטבלת התאמה לפי גובה ומשקל:
- XS — גובה 1.50-1.60 מטר, משקל 50-60 ק"ג
- S — גובה 1.60-1.70 מטר, משקל 60-70 ק"ג
- M — גובה 1.65-1.75 מטר, משקל 65-75 ק"ג
- L — גובה 1.70-1.80 מטר, משקל 70-80 ק"ג
- XL — גובה 1.75-1.85 מטר, משקל 80-90 ק"ג
- XXL — גובה 1.80-1.90 מטר, משקל 90-110 ק"ג
- 3XL — גובה 1.80-1.90 מטר, משקל 100 ק"ג ומעלה

החולצות הן אוברסייז:
- מומלץ לקחת את המידה הרגילה אם אוהבים אוברסייז
- לקחת מידה אחת פחות אם רוצים שיהיה יותר צמוד
- אם הנתונים לא מסתדרים עם הטבלה — כתוב [ESCALATE: לקוח עם מידות לא סטנדרטיות, גובה X משקל Y]

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
- ביט / פייבוקס — העבר למספר 0543184416, שלח צילום מסך של אישור ההעברה, ולאחר מכן שם מלא, כתובת וטלפון למשלוח
- העברה בנקאית:
  שם המוטב: נתנאל ליכטנברג
  בנק: מזרחי טפחות
  סניף: 441
  מספר חשבון: 136545
  לאחר ההעברה — שלח צילום מסך + שם מלא, כתובת וטלפון למשלוח
- אשראי טלפוני — התקשר ל-0543184416 בשעות הפעילות
- אשראי באתר: https://mygiftbox.co.il/מארזי-מתנה-לגבר/חולצות-ציצית/

החזרות והחלפות:
- ניתן להחזיר/להחליף באמצעות שליחויות או הגעה פיזית למחסן בצופים בתיאום מראש
- אם לקוח חושש לגבי מידה — הרגע אותו: אנחנו מתאימים מידות באופן מדויק מאוד
- אם יש טעות במידה — מבצעים החלפה באמצעות שליח וטיפול מלא מצדנו
- המטרה שלנו היא שכל לקוח יהיה מרוצה 100%

תמונות:
- אם לקוח מבקש לראות איך נראית חולצה בודדת, או מבקש לראות צבע מסוים, אתה יכול לשלוח לו תמונה
- כדי לשלוח תמונה של חולצה בודדת, כתוב בתשובה שלך תג בפורמט: [IMAGE: שם_הצבע] (שם הצבע באנגלית, אחד מהבאים: black, white, gray, navy, stone, brown, lightbrown, multicolor)
- "multicolor" משמש כשהלקוח מבקש לראות את כל הצבעים יחד / קולקציה כללית
- כדי לשלוח תמונה של סט (חולצה + מכנס), כתוב תג בפורמט: [IMAGE: set-שם_הצבע] - הצבעים הזמינים לסט: set-black, set-white, set-lightbrown, set-navy, set-brown
- אל תשתמש בתג של סט עבור חולצה בודדת ולהיפך - אלו תמונות שונות
- ניתן לשלב כמה תגי תמונה בתשובה אחת אם הלקוח מבקש כמה צבעים
- לצבע "שמנת" אין כרגע תמונה מצולמת (לא לחולצה בודדת ולא לסט) - אם מתבקש, הסבר שאין דגם מצולם של הצבע הזה כרגע אבל הוא קיים במלאי
- שלב את תג התמונה בטבעיות בתוך הטקסט, למשל: "בטח! הנה איך נראית בשחור [IMAGE: black] יפה מאוד, נכון?"
- הערה טכנית: בתחילת שיחה חדשה עם לקוח, המערכת שולחת אוטומטית (בלי שתצטרך לכתוב תג) כמה תמונות פתיחה (קולקציה כללית, שחור, לבן, חום בהיר). אתה לא צריך לכתוב תג IMAGE עבור זה - זה קורה אוטומטית אחרי התשובה הראשונה שלך. אתה רק צריך לדעת שזה קורה, כדי שהתשובה הראשונה שלך תהיה מתאימה (למשל אפשר לציין בקצרה שאתה מצרף כמה תמונות לדוגמה)

כללי התנהגות:
- ענה בצורה קצרה וברורה
- אם לקוח מתעניין — נסה לסגור מכירה בצורה טבעית ולא דוחפנית
- בסוף כל שיחת מכירה — שלח את קישור האתר לרכישה
- אל תמציא מידע שלא ניתן לך

מתי לעצור ולהעביר לבעלים (escalation) - אלה החריגים שדורשים אישור אנושי:
- בקשות תשלום לא סטנדרטיות (מזומן, הנחה, תנאי תשלום מיוחדים)
- בקשות איסוף/משלוח לא רגילות (איסוף עצמי שלא בשעות הרגילות, משלוח לאזור מרוחק, בקשה שהבעלים יגיע אישית)
- כל בקשה לתנאים מיוחדים, הנחות, או חריגות ממה שכתוב במידע שניתן לך
- שאלה שאין לך תשובה עליה מהמידע שניתן לך
- כל מקרה שמרגיש לא שגרתי או רגיש (תלונה, בעיה במוצר שהתקבל, בקשה חריגה)

כשאתה מחליט להסלים, כתוב בפורמט הזה (כדי שהבעלים יידע בדיוק על מה השאלה):
[ESCALATE: תיאור קצר של מה הלקוח מבקש/שואל]

לדוגמה:
- לקוח רוצה לשלם במזומן ולתאם הגעה → [ESCALATE: לקוח מבקש לשלם במזומן, צריך לבדוק איפה הוא גר ואם זה מתאים ללו"ז]
- לקוח שואל על הנחה לכמות גדולה → [ESCALATE: לקוח מבקש הנחה על הזמנה של 10 חולצות]

לגבי בקשות חריגות - אל תגיד ללקוח "אין אפשרות" או "לא ניתן" בעצמך. במקום זה תגיד שאתה בודק ותחזור אליו, ותפעיל [ESCALATE].`;

async function buildSystemPrompt() {
  const updates = await getLiveUpdates();
  if (updates.length === 0) return BASE_SYSTEM_PROMPT;
  return `${BASE_SYSTEM_PROMPT}

עדכונים חדשים מהבעלים (מידע עדכני - תמיד תעדיף אותו על פני המידע שמעליו אם יש סתירה):
${updates.map((u, i) => `${i + 1}. ${u.content}`).join('\n')}`;
}

// ===== WhatsApp send helper =====

// ===== Product images =====
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/mygiftbox12-create/whatsapp-agent/main/images';
const COLOR_IMAGE_MAP = {
  black: `${GITHUB_RAW_BASE}/shirt-black.jpeg`,
  white: `${GITHUB_RAW_BASE}/shirt-white.jpeg`,
  gray: `${GITHUB_RAW_BASE}/shirt-gray.jpeg`,
  navy: `${GITHUB_RAW_BASE}/set-navy.jpeg`,
  stone: `${GITHUB_RAW_BASE}/shirt-stone.jpeg`,
  brown: `${GITHUB_RAW_BASE}/shirt-brown.jpeg`,
  lightbrown: `${GITHUB_RAW_BASE}/shirt-lightbrown.jpeg`,
  multicolor: `${GITHUB_RAW_BASE}/shirt-multicolor.jpeg`
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

// Sent automatically once, with the agent's first reply in a new conversation
const WELCOME_IMAGE_URLS = [
  `${GITHUB_RAW_BASE}/shirt-multicolor.jpeg`,
  `${GITHUB_RAW_BASE}/shirt-black.jpeg`,
  `${GITHUB_RAW_BASE}/shirt-white.jpeg`,
  `${GITHUB_RAW_BASE}/set-lightbrown.jpeg`
];

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
    if (!message || message.type !== 'text') return;

    const from = message.from;
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
        system: await buildSystemPrompt(),
        messages: history
      })
    });

    const claudeData = await claudeRes.json();
    const reply = claudeData.content?.[0]?.text || '[ESCALATE: שגיאה טכנית בסוכן]';

    const escalateMatch = reply.match(/\[ESCALATE(?::\s*(.+?))?\]/);

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
      const { cleanText } = extractImageTags(reply);
      await appendConversation(from, 'assistant', cleanText || reply);
      await sendReplyWithImages(from, reply);

      if (isFirstMessageInConversation) {
        for (const url of WELCOME_IMAGE_URLS) {
          await sendWhatsAppImage(from, url);
        }
      }
    }
  } catch (e) {
    console.error('Webhook handler error:', e);
  }
});

app.get('/health', (req, res) => res.send('ok'));

initDb()
  .then(() => {
    app.listen(3000, () => console.log('Server running on port 3000, DB initialized.'));
  })
  .catch(err => {
    console.error('Failed to initialize DB:', err);
    process.exit(1);
  });
