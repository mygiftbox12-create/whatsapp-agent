const express = require('express');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "myshirt2025";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OWNER_PHONE = process.env.OWNER_PHONE || "972543184416";

// ===== In-memory state (resets on server restart / sleep) =====
// Map of customer phone -> { lastMessage, lastEscalatedAt, awaitingOwnerReply }
const pendingEscalations = new Map();
// Map of customer phone -> array of recent turns (for context, optional/simple)
const conversationLog = new Map();
// Extra info the owner has added live (appended to system prompt)
let liveUpdates = [];
// Simple counters for /status
const stats = {
  totalMessages: 0,
  totalEscalations: 0,
  startedAt: new Date()
};

const BASE_SYSTEM_PROMPT = `אתה סוכן שירות לקוחות מקצועי ואדיב של חנות חולצות ציצית מהודרות ואופנתיות בשם My Gift.
ענה תמיד בעברית, בצורה חמה, ידידותית ומקצועית.

מידע על המוצרים והמחירים:
- חולצת ציצית מהודרת ואופנתית — 250 ₪ ליחידה
- 2 חולצות — 450 ₪
- 3 חולצות — 600 ₪
- 4 חולצות ומעלה — 200 ₪ ליחידה

צבעים זמינים:
שחור, לבן, שמנת, אפור, כחול נייבי, אבן, חום כהה, חום בהיר

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

function buildSystemPrompt() {
  if (liveUpdates.length === 0) return BASE_SYSTEM_PROMPT;
  return `${BASE_SYSTEM_PROMPT}

עדכונים חדשים מהבעלים (מידע עדכני - תמיד תעדיף אותו על פני המידע שמעליו אם יש סתירה):
${liveUpdates.map((u, i) => `${i + 1}. ${u}`).join('\n')}`;
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
  // strip non-digits for safer comparisons
  return (p || '').replace(/\D/g, '');
}

const OWNER_PHONE_NORMALIZED = normalizePhone(OWNER_PHONE);

// ===== Owner command handlers =====

async function handleOwnerCommand(text) {
  const trimmed = text.trim();

  // /status
  if (trimmed === '/status' || trimmed === '/סטטוס') {
    const uptimeMin = Math.floor((Date.now() - stats.startedAt.getTime()) / 60000);
    const openEscalations = [...pendingEscalations.entries()]
      .filter(([, v]) => v.awaitingOwnerReply);
    let report = `📊 *סטטוס סוכן*\n`;
    report += `🕐 פעיל: ${uptimeMin} דקות\n`;
    report += `💬 הודעות שטופלו: ${stats.totalMessages}\n`;
    report += `⚠️ פניות שהועברו אליך: ${stats.totalEscalations}\n`;
    report += `🔓 פניות פתוחות (ממתינות לתשובה): ${openEscalations.length}\n`;
    if (openEscalations.length > 0) {
      report += `\nרשימת פניות פתוחות:\n`;
      for (const [phone, info] of openEscalations) {
        report += `• ${phone}: "${info.lastMessage}"\n  📋 ${info.description || 'ללא פירוט'}\n`;
      }
    }
    if (liveUpdates.length > 0) {
      report += `\n📝 עדכונים פעילים:\n`;
      liveUpdates.forEach((u, i) => { report += `${i + 1}. ${u}\n`; });
    }
    await sendWhatsAppMessage(OWNER_PHONE, report);
    return true;
  }

  // /update <text>
  if (trimmed.startsWith('/update ') || trimmed.startsWith('/עדכון ')) {
    const content = trimmed.replace(/^\/(update|עדכון)\s+/, '').trim();
    if (content) {
      liveUpdates.push(content);
      await sendWhatsAppMessage(OWNER_PHONE, `✅ נוסף עדכון: "${content}"\nהסוכן ישתמש בזה מעכשיו.`);
    }
    return true;
  }

  // /clearupdates
  if (trimmed === '/clearupdates' || trimmed === '/נקה') {
    liveUpdates = [];
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
    const targetPhone = normalizePhone(rest.slice(0, spaceIdx));
    const replyText = rest.slice(spaceIdx + 1).trim();

    // find matching pending escalation by normalized phone
    let matchedKey = null;
    for (const key of pendingEscalations.keys()) {
      if (normalizePhone(key) === targetPhone || normalizePhone(key).endsWith(targetPhone)) {
        matchedKey = key;
        break;
      }
    }

    if (!matchedKey) {
      await sendWhatsAppMessage(OWNER_PHONE, `⚠️ לא נמצאה פנייה פתוחה ממספר ${rest.slice(0, spaceIdx)}. שלח /status לרשימה.`);
      return true;
    }

    await sendWhatsAppMessage(matchedKey, replyText);
    pendingEscalations.delete(matchedKey);

    // Save this into conversation history so the agent has context if customer follows up
    const history = conversationLog.get(matchedKey) || [];
    history.push({ role: 'assistant', content: replyText });
    conversationLog.set(matchedKey, history.slice(-10));

    await sendWhatsAppMessage(OWNER_PHONE, `✅ נשלח ללקוח ${matchedKey}:\n"${replyText}"`);
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
      `💡 הסוכן יעביר אליך אוטומטית כל בקשה חריגה (תשלום במזומן, הנחות, תנאים מיוחדים) עם תיאור קצר של הבקשה.`;
    await sendWhatsAppMessage(OWNER_PHONE, helpText);
    return true;
  }

  // not a recognized command -> let it fall through to normal flow (owner just chatting)
  return false;
}

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
      // If owner sent a plain message (not a command), just acknowledge.
      await sendWhatsAppMessage(OWNER_PHONE,
        'קיבלתי 👍 (שלח /help לרשימת פקודות: /status, /update, /reply)');
      return;
    }

    // ===== Regular customer flow =====
    stats.totalMessages++;

    // Maintain simple conversation history per customer (for context across messages)
    const history = conversationLog.get(from) || [];
    history.push({ role: 'user', content: text });
    // keep last 10 turns to avoid unbounded growth
    const trimmedHistory = history.slice(-10);

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
        system: buildSystemPrompt(),
        messages: trimmedHistory
      })
    });

    const claudeData = await claudeRes.json();
    const reply = claudeData.content?.[0]?.text || '[ESCALATE: שגיאה טכנית בסוכן]';

    // Match [ESCALATE] or [ESCALATE: description]
    const escalateMatch = reply.match(/\[ESCALATE(?::\s*(.+?))?\]/);

    if (escalateMatch) {
      stats.totalEscalations++;
      const description = escalateMatch[1] || 'לא צוין פירוט';
      pendingEscalations.set(from, {
        lastMessage: text,
        description,
        lastEscalatedAt: new Date(),
        awaitingOwnerReply: true
      });
      // Don't save the [ESCALATE] reply itself into history
      await sendWhatsAppMessage(from, 'תודה על פנייתך! נציג שלנו יחזור אליך בהקדם 🙏');
      await sendWhatsAppMessage(
        OWNER_PHONE,
        `⚠️ *פנייה חדשה דורשת התערבות*\n\n👤 לקוח: ${from}\n💬 הודעה: "${text}"\n📋 סיכום: ${description}\n\nלענות: /reply ${from} <התשובה שלך>\nאם זה כלל קבוע להבא: /update <הכלל>`
      );
    } else {
      history.push({ role: 'assistant', content: reply });
      conversationLog.set(from, history.slice(-10));
      await sendWhatsAppMessage(from, reply);
    }
  } catch (e) {
    console.error(e);
  }
});

app.listen(3000, () => console.log('Server running on port 3000'));
