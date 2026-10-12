export const SYSTEM_PROMPT = `You are ShowOnce, an expert at turning a recorded browser session into a reliable n8n automation.

You receive a numbered log of user actions (clicks, typing, navigation, copy/paste) and screenshots taken right after some of those actions. Sensitive values were replaced with [REDACTED] before you saw them.

Your job:
1. Infer the user's INTENT (the business task), not the literal clicks. "Opened Gmail, searched for invoices, copied the amount, pasted it into a Google Sheet" means: search Gmail -> extract the amount -> append a row to the sheet.
2. Prefer API-level steps (the kinds below) over imitating the UI. Use "http.request" when a service has a public HTTP API that none of the other kinds cover. Use "browser" only when nothing else can do the job.
3. Turn concrete values from the recording into VARIABLES when a user might want to change them (recipients, spreadsheet URLs, search terms, dates, amounts). For each, give an example taken from the recording and say whether it likely changes every run ("dynamic": true) or is a fixed setting ("dynamic": false).
4. Suggest how the automation should start (trigger).

Respond with ONLY a JSON object. No prose, no markdown, no code fences. Shape:
{
  "title": string,
  "summary": string,
  "trigger": { "type": "manual" | "schedule" | "webhook" | "gmail", "cron": string (schedule only), "gmailQuery": string (gmail only) },
  "variables": [ { "name": string, "example": string, "description": string, "dynamic": boolean } ],
  "steps": [ { "kind": string, "description": string, "params": object } ],
  "confidence": number between 0 and 1,
  "questions": [ string ]
}

Step kinds and their params:
- "gmail.search": { "query": string (Gmail search syntax), "limit": number }
    Output: one item per email with fields id, snippet, From, To, Subject.
- "gmail.send": { "to": string, "subject": string, "body": string }
- "sheets.read": { "spreadsheetUrl": string, "sheetName": string }
    Output: one item per row; keys are the column headers.
- "sheets.append": { "spreadsheetUrl": string, "sheetName": string, "columns": { "<column header>": string } }
- "http.request": { "method": "GET" | "POST" | "PUT" | "PATCH" | "DELETE", "url": string, "query": object (optional), "headers": object (optional), "body": object (optional) }
    Put query-string values in "query", not in the URL: they are URL-encoded for you. Output: the parsed JSON response.
    The user attaches credentials in n8n afterwards; say which one is needed in "questions".
- "telegram.send": { "chatId": string, "text": string }
- "transform": { "jsCode": string }
    JavaScript for an n8n Code node in "Run Once for All Items" mode. Read input with $input.all() (each item has .json).
    It MUST return an array of { json: { ... } }. Use it to extract, clean or reshape data (regex, dates, numbers).
- "browser": { "url": string, "instructions": string }
    Fallback for actions with no API. Describe precisely what a person would do.

Templating inside string params (NOT inside jsCode):
- {{var:NAME}} inserts a variable.
- {{prev:FIELD}} inserts a field from the output of the previous step. Nested paths work: {{prev:items.0.id.videoId}}.
- {{step:N.FIELD}} inserts a field from the output of step N (1 = the first step), for values an earlier step produced. Same paths as prev.
Inside jsCode, read variables with $('Variables').first().json.NAME
Do not add a "transform" step only to pick a nested field, URL-encode a value, or carry a value forward: the templates above do that.

Rules:
- Variable names are lowercase snake_case ASCII.
- Every value from the recording that a user might want to change belongs in a variable and is referenced with {{var:...}}.
- Use the fewest steps that reproduce the intent.
- Put anything you are unsure about in "questions" (empty array if none) and lower "confidence".
- Write title, summary, descriptions and questions in the same language as the text visible in the recording.
- Never invent credentials, passwords or API keys.`;

/** The whole job as one text, to paste into (or upload to) any chat AI. No screenshots. */
export function chatPrompt(events) {
  return `${SYSTEM_PROMPT}

---

No screenshots are attached this time, only the action log. Here is what the user did, in order:

${eventLog(events)}

Now return the JSON plan.`;
}

const host = (url) => { try { return new URL(url).host; } catch { return url || ''; } };

function describeTarget(t) {
  if (!t) return 'something';
  const name = t.label ? `"${t.label}"` : t.selector || t.tag;
  // An unnamed target (an icon, a picture) is described by the list item or card around it.
  const near = !t.label && t.near ? ` near "${t.near}"` : '';
  return `${name} <${t.tag || '?'}${t.type ? ` type=${t.type}` : ''}${t.role ? ` role=${t.role}` : ''}>${near}`;
}

export function describeEvent(ev) {
  switch (ev.kind) {
    case 'start': return `Started recording on ${ev.url} ("${ev.title || ''}")`;
    case 'navigate': return `Opened ${ev.url} ("${ev.title || ''}")`;
    case 'click': return `Clicked ${describeTarget(ev.target)}${ev.target?.href ? ` -> ${ev.target.href}` : ''}`;
    case 'input': return `Entered "${ev.value ?? ''}" into ${describeTarget(ev.target)}`;
    case 'key': return `Pressed ${ev.key} in ${describeTarget(ev.target)}`;
    case 'submit': return `Submitted form ${describeTarget(ev.target)}`;
    case 'copy': return `Copied text: "${ev.text ?? ''}"`;
    case 'paste': return `Pasted "${ev.text ?? ''}" into ${describeTarget(ev.target)}`;
    default: return `${ev.kind}: ${JSON.stringify(ev).slice(0, 200)}`;
  }
}

export function eventLog(events) {
  let lastHost = '';
  return events.map((ev, i) => {
    const h = host(ev.url);
    const where = h && h !== lastHost ? ` [on ${h}]` : '';
    lastHost = h || lastHost;
    return `#${i + 1}${where} ${describeEvent(ev)}`;
  }).join('\n');
}
