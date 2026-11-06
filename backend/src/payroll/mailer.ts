/**
 * ✉️ Канал «email» центру сповіщень (ТЗ «Зарплата» §6). Мінімальний SMTP-клієнт на `node:tls` — без нових залежностей
 * (у проєкті сторонні пакети не доставляються на прод `npm i`; прецедент — pdf-lib і shevchenko у vendor).
 *
 * Налаштування — `.env`: `SMTP_URL=smtps://логін:пароль@smtp.gmail.com:465` (лише неявний TLS, порт 465) і
 * `SMTP_FROM="UTS Dashboard <noreply@…>"` (без нього — логін). Немає `SMTP_URL` → канал вимкнено, і це видно в
 * налаштуваннях сповіщень («email не налаштовано»), а не тихо: лист просто не піде, дзвіночок і Telegram працюють.
 */
import tls from "node:tls";

export interface MailConfig { host: string; port: number; user: string; pass: string; from: string }

export function mailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig | null {
  const raw = env.SMTP_URL?.trim(); if (!raw) return null;
  let u: URL; try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "smtps:" || !u.hostname || !u.username) return null;
  const user = decodeURIComponent(u.username), pass = decodeURIComponent(u.password);
  return { host: u.hostname, port: Number(u.port) || 465, user, pass, from: env.SMTP_FROM?.trim() || user };
}
export const mailReady = () => mailConfig() !== null;

/** «Тема» UTF-8 у заголовку — encoded-word (RFC 2047). */
const encWord = (s: string) => `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
/** Адреса в `From`: «Імʼя <a@b>» → імʼя закодовано, адреса як є. */
function fromHeader(from: string): { header: string; addr: string } {
  const m = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(from);
  return m ? { header: `${m[1].trim() ? encWord(m[1].trim()) + " " : ""}<${m[2]}>`, addr: m[2] } : { header: `<${from}>`, addr: from };
}
/** Тіло листа: заголовки + base64 (рядки по 76), щоб кирилиця й крапка на початку рядка не ламали SMTP. */
export function buildMessage(from: string, to: string, subject: string, text: string, date = new Date()): string {
  const f = fromHeader(from);
  const body = Buffer.from(text, "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n");
  return [`From: ${f.header}`, `To: <${to}>`, `Subject: ${encWord(subject)}`, `Date: ${date.toUTCString()}`, "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", body].join("\r\n");
}

/** Надіслати один лист. Кидає помилку з відповіддю сервера — викликач логує, сповіщення в дашборді лишається. */
export async function sendMail(cfg: MailConfig, to: string, subject: string, text: string): Promise<void> {
  const sock = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host });
  sock.setEncoding("utf8"); sock.setTimeout(20_000);
  let buf = ""; const waiters: Array<(line: string) => void> = [];
  const fail = (e: Error) => { sock.destroy(); while (waiters.length) waiters.shift()!(`599 ${e.message}`); };
  sock.on("timeout", () => fail(new Error("тайм-аут SMTP")));
  sock.on("error", (e) => fail(e));
  sock.on("data", (d: string) => {
    buf += d;
    // відповідь закінчено, коли останній рядок має пробіл після коду («250 OK», а не «250-…»)
    let m: RegExpExecArray | null;
    while ((m = /^(\d{3}) [^\r\n]*\r?\n/m.exec(buf))) { const end = m.index + m[0].length; const all = buf.slice(0, end); buf = buf.slice(end); waiters.shift()?.(all); }
  });
  const reply = () => new Promise<string>((res) => waiters.push(res));
  const expect = async (codes: number[], cmd?: string) => {
    if (cmd !== undefined) sock.write(cmd + "\r\n");
    const r = await reply(); const code = Number(r.slice(0, 3));
    if (!codes.includes(code)) { sock.destroy(); throw new Error(`SMTP ${cmd?.split(" ")[0] ?? "привітання"}: ${r.trim().split("\n").pop()}`); }
    return r;
  };
  try {
    await expect([220]);
    await expect([250], `EHLO ${cfg.host}`);
    await expect([334], "AUTH LOGIN");
    await expect([334], Buffer.from(cfg.user).toString("base64"));
    await expect([235], Buffer.from(cfg.pass).toString("base64"));
    await expect([250], `MAIL FROM:<${fromHeader(cfg.from).addr}>`);
    await expect([250, 251], `RCPT TO:<${to}>`);
    await expect([354], "DATA");
    // «крапка на початку рядка» неможлива: тіло — base64, заголовки наші
    await expect([250], buildMessage(cfg.from, to, subject, text) + "\r\n.");
    sock.write("QUIT\r\n");
  } finally { sock.end(); }
}
