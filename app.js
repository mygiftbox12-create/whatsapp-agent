const express = require('express');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "myshirt2025";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OWNER_PHONE = process.env.OWNER_PHONE || "972543184416";

const SYSTEM_PROMPT = `אתה סוכן שירות לקוחות מקצועי ואדיב של חנות חולצות ציצית מהודרות ואופנתיות בשם My Gift.
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
- אם הנתונים לא מסתדרים עם הטבלה — כתוב [ESCALATE]

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
- אם שואלים שאלה שאין לך תשובה עליה — כתוב בדיוק: [ESCALATE]
- אל תמציא מידע שלא ניתן לך`;

async function sendWhatsAppMessage(to, text) {
  await fetch(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, {
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
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text }]
      })
    });

    const claudeData = await claudeRes.json();
    const reply = claudeData.content?.[0]?.text || '[ESCALATE]';

    if (reply.includes('[ESCALATE]')) {
      await sendWhatsAppMessage(from, 'תודה על פנייתך! נציג שלנו יחזור אליך בהקדם 🙏');
      await sendWhatsAppMessage(OWNER_PHONE, `⚠️ פנייה חדשה מלקוח ${from}:\n"${text}"\nהסוכן לא ידע לענות — נא לטפל!`);
    } else {
      await sendWhatsAppMessage(from, reply);
    }
  } catch (e) {
    console.error(e);
  }
});

app.listen(3000, () => console.log('Server running on port 3000'));
