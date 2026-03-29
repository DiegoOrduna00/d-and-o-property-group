const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MAKE_WEBHOOK = "https://hook.us2.make.com/nyopjdofnk8r7rnfy5rksj6qbwd9et";

// In-memory store for conversations and follow-up state
const conversations = {};
const followUpSchedule = {};

const FOLLOWUP_DAYS = [2, 5, 10];
const FOLLOWUP_MSGS = {
  en: [
    "Hey [NAME]! Just wanted to follow up — still interested in a cash offer for your property? No pressure at all, just checking in 🙂",
    "Hi [NAME], I know life gets busy! Still open to chatting about your property? We're actively buying in your area and would love to help.",
    "Hey [NAME] — last follow-up from me, I promise! If the timing ever works out, we'd love to make you a cash offer. Wishing you all the best either way 🤙"
  ],
  es: [
    "Hola [NAME]! Solo quería hacer seguimiento — ¿sigue interesado en una oferta en efectivo por su propiedad? Sin presión, solo verificando 🙂",
    "Hola [NAME], ¡sé que la vida se pone ocupada! ¿Sigue abierto a hablar sobre su propiedad? Estamos comprando activamente en su área.",
    "Hola [NAME] — ¡último seguimiento de mi parte, lo prometo! Si alguna vez el momento es adecuado, nos encantaría hacerle una oferta. ¡Les deseo lo mejor! 🤙"
  ]
};

const SYSTEM = `You are Sofia, a friendly acquisition assistant for D&O Property Group, a real estate company in Houston TX run by Diego. Your only job is to qualify sellers and either book a call with Diego OR close a deal over text.

LANGUAGE RULE: Detect the language of the seller's very first message and respond in that exact language for the ENTIRE conversation. Spanish stays Spanish. English stays English. Never mix. Never ask.

Ask ONE question at a time. 2-3 sentences max. Sound like a real human texting. Never mention ARV, MAO, or formulas to the seller.

---

OPENING FLOW — FOLLOW THIS EXACTLY, NO EXCEPTIONS:

STEP A — Seller gives their name (or confirms it).
STEP B — Your VERY NEXT message MUST be ONLY this, nothing else: "Quick question — are you the owner of the property, or are you a property manager or agent?" / "Una pregunta rápida — ¿es usted el dueño de la propiedad, o es un administrador o agente?"
CRITICAL: Do NOT ask about the property. Do NOT say "do you have a property to sell." Do NOT skip Step B under ANY circumstances. Step B is MANDATORY before anything else.

After they answer Step B, THEN branch:

---

IF OWNER — proceed with full qualification:

STEP 1 - Collect in order: property address (if not already known from lead), motivation for selling, timeline, condition (great/good/needs work/major repairs), asking price, mortgage balance.

STEP 2 - Ask: "This sounds like a great fit! Would you prefer a quick 15-minute phone call with Diego, or would you like me to put together a ballpark offer right here over text?" / "Esto suena muy bien! ¿Prefiere una llamada rápida de 15 minutos con Diego, o le gustaría que le diera un rango de oferta aquí por mensaje?"

STEP 3A - PHONE CALL PATH: Ask mornings or afternoons, confirm specific time, end with "Perfect! Diego will call you at [TIME]. No pressure at all, just a quick chat." / "Perfecto! Diego le llamará a las [HORA]. Sin presión, solo una charla rápida."

STEP 3B - TEXT OFFER PATH:
- Present offer: "Based on what you've shared, and factoring in repairs and our costs since we buy completely as-is, Diego would likely be in the range of $[MAO_LOW] to $[MAO_HIGH]. Does that range work for you?"
- Calculate MAO_LOW = asking price x 0.55, MAO_HIGH = asking price x 0.65
- If seller says YES to range: "Awesome! To get the paperwork started I just need your email address so we can send over the purchase agreement." Then output the LEAD tag.
- If seller COUNTERS with a higher number: Check if their counter is under MAO_HIGH. If yes say "You know what, we can make [THEIR NUMBER] work. Let me get your email to send the purchase agreement right over." If their counter is too high say "I totally understand, and I wish we could go higher — but [MAX] is honestly the most we can offer given the repairs and our holding costs. Would that work?"
- If seller is NOT HAPPY with any number: "I completely understand — I never want you to feel pressured. Here is what I can do — let me get Diego on the phone with you as fast as possible. He is motivated to make this work and may have more flexibility than I do over text. What is the best number to reach you, and are you available in the next hour or two?"
- If seller gives their number for urgent call: Output the LEAD tag immediately with preference=URGENT-CALL and calltime=ASAP.

---

IF AGENT OR PROPERTY MANAGER — switch to business mode immediately:

Say: "Perfect, I work with cash buyers throughout the Houston area. Is the owner open to a cash offer below market value? What would be the best way to reach them or pass along our interest?" / "Perfecto, trabajo con compradores en efectivo en toda el área de Houston. ¿Está el dueño abierto a una oferta en efectivo por debajo del valor de mercado? ¿Cuál sería la mejor forma de contactarle o hacerle llegar nuestro interés?"

Collect: owner contact info or best way to reach decision maker. Then output LEAD tag with preference=AGENT-REFERRAL.

---

FOLLOW-UP CONTEXT: If the message starts with [FOLLOW-UP DAY X], Sofia is resuming after a follow-up. Pick up naturally, be warm, and continue qualifying.

---

When deal confirmed OR urgent call OR agent referral triggered, output at end of message:
[LEAD name=X address=X motivation=X timeline=X condition=X asking=X owed=X calltime=X preference=call or text or URGENT-CALL or AGENT-REFERRAL email=X]`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const from = req.body.From;
  const message = req.body.Body;

  if (!conversations[from]) conversations[from] = [];

  // Mark follow-up as replied if one was sent
  if (followUpSchedule[from] && followUpSchedule[from].awaitingReply) {
    followUpSchedule[from].awaitingReply = false;
    followUpSchedule[from].lastReply = new Date();
    fetch(MAKE_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: new Date().toLocaleDateString(),
        event: "FOLLOW_UP_REPLY",
        phone: from,
        seller: followUpSchedule[from].name || "Unknown",
        followup_day: FOLLOWUP_DAYS[followUpSchedule[from].followUpsSent - 1],
        note: "Seller replied to follow-up — Sofia resuming conversation. Diego notified."
      })
    }).catch(() => {});
  }

  // Init follow-up schedule on first contact
  if (!followUpSchedule[from]) {
    followUpSchedule[from] = {
      name: "",
      lang: "en",
      lastReply: new Date(),
      followUpsSent: 0,
      stopped: false,
      awaitingReply: false,
      timers: []
    };
  }

  followUpSchedule[from].lastReply = new Date();

  // Detect language
  const spanishWords = ["hola","quiero","vender","casa","necesito","pido","debo","soy","dueño","sí"];
  if (conversations[from].length === 0) {
    followUpSchedule[from].lang = spanishWords.some(w => message.toLowerCase().includes(w)) ? "es" : "en";
    followUpSchedule[from].name = message.split(" ")[0];
  }

  conversations[from].push({ role: "user", content: message });

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: SYSTEM,
      messages: conversations[from],
    });

    const reply = response.content[0].text;
    conversations[from].push({ role: "assistant", content: reply });

    // Check for lead tag
    const leadMatch = reply.match(/\[LEAD([^\]]+)\]/);
    if (leadMatch) {
      const raw = leadMatch[1];
      const get = k => { const r = raw.match(new RegExp(k+"=([^=\\[\\]]+?)(?=\\s+\\w+=|$)")); return r?r[1].trim():null; };
      const lead = {
        date: new Date().toLocaleDateString(),
        name: get("name"), address: get("address"), motivation: get("motivation"),
        timeline: get("timeline"), condition: get("condition"), asking: get("asking"),
        owed: get("owed"), calltime: get("calltime"), preference: get("preference"),
        email: get("email"), phone: from,
      };
      if (lead.name) followUpSchedule[from].name = lead.name;
      followUpSchedule[from].stopped = true; // Stop follow-ups on deal close
      await fetch(MAKE_WEBHOOK, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lead),
      });
    }

    // Schedule follow-ups after first exchange
    if (conversations[from].length === 2 && !followUpSchedule[from].stopped) {
      scheduleFollowUps(from);
    }

    const cleanReply = reply.replace(/\[LEAD[^\]]*\]/g, "").trim();
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${cleanReply}</Message>
</Response>`);

  } catch (e) {
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>Hey! We're experiencing a technical issue. Please try again in a moment.</Message>
</Response>`);
  }
}

function scheduleFollowUps(phone) {
  const schedule = followUpSchedule[phone];
  if (!schedule) return;

  FOLLOWUP_DAYS.forEach((day, idx) => {
    const delayMs = day * 24 * 60 * 60 * 1000;
    const timer = setTimeout(async () => {
      if (schedule.stopped) return;
      const hoursSinceReply = (new Date() - schedule.lastReply) / (1000 * 60 * 60);
      if (hoursSinceReply < 23) return; // Skip if seller replied recently

      const msgs = FOLLOWUP_MSGS[schedule.lang] || FOLLOWUP_MSGS.en;
      const msg = msgs[idx].replace("[NAME]", schedule.name || "there");

      conversations[phone] = conversations[phone] || [];
      conversations[phone].push({ role: "assistant", content: `[FOLLOW-UP DAY ${day}] ${msg}` });

      schedule.followUpsSent = idx + 1;
      schedule.awaitingReply = true;

      try {
        const twilioSid = process.env.TWILIO_ACCOUNT_SID;
        const twilioAuth = process.env.TWILIO_AUTH_TOKEN;
        const twilioFrom = process.env.TWILIO_PHONE_NUMBER;
        if (twilioSid && twilioAuth && twilioFrom) {
          await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "Authorization": "Basic " + Buffer.from(`${twilioSid}:${twilioAuth}`).toString("base64")
            },
            body: new URLSearchParams({ From: twilioFrom, To: phone, Body: msg })
          });
        }
        await fetch(MAKE_WEBHOOK, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date: new Date().toLocaleDateString(),
            event: `FOLLOW_UP_DAY_${day}`,
            phone, seller: schedule.name, message: msg
          })
        });
      } catch (e) {
        console.error("Follow-up send error:", e);
      }
    }, delayMs);

    schedule.timers = schedule.timers || [];
    schedule.timers.push(timer);
  });
}
