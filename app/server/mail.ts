// Sending one email: a MIME message built by hand and a minimal SMTP conversation.
// Best on the mail server's own machine, logged in (127.0.0.1:465, TLS, an account that may log in from localhost
// only). The login matters: mail dropped on port 25 without one counts as incoming mail, gets no
// DKIM signature, fails SPF from 127.0.0.1 and so DMARC (p=reject), and lands in Spam.
import { connect } from "node:net";
import { connect as connectTls } from "node:tls";

export type Inline = { cid: string; mime: string; bytes: Uint8Array; name: string };
export type Mail = { from: string; to: string; subject: string; text: string; html: string; inline?: Inline[]; fromName?: string; replyTo?: string };

const b64 = (b: Uint8Array | string) => Buffer.from(b).toString("base64").replace(/.{76}/g, "$&\r\n");
// a header value with anything beyond ASCII goes as an RFC 2047 encoded word
const word = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`;
export const validAddress = (s: string) => /^[^\s@<>()",;:]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(s);

export function mime(m: Mail, now = new Date()): string {
  const id = crypto.randomUUID(), alt = `alt-${id}`, rel = `rel-${id}`, domain = m.from.split("@")[1] ?? "localhost";
  const head = [
    `From: ${word((m.fromName ?? "peppermint").replace(/[<>"\r\n]/g, ""))} <${m.from}>`, `To: <${m.to}>`, ...(m.replyTo && validAddress(m.replyTo) ? [`Reply-To: <${m.replyTo}>`] : []), `Subject: ${word(m.subject)}`, `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${id}@${domain}>`, "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${alt}"`,
  ];
  const parts = [
    `--${alt}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(m.text),
    `--${alt}`, `Content-Type: multipart/related; type="text/html"; boundary="${rel}"`, "",
    `--${rel}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(m.html),
    ...(m.inline ?? []).flatMap(i => [`--${rel}`, `Content-Type: ${i.mime}; name="${i.name}"`, "Content-Transfer-Encoding: base64", `Content-ID: <${i.cid}>`, `Content-Disposition: inline; filename="${i.name}"`, "", b64(i.bytes)]),
    `--${rel}--`, `--${alt}--`, "",
  ];
  return [...head, "", ...parts].join("\r\n");
}

/** Sends through SMTP (PEPPERMINT_SMTP="host:port", default 127.0.0.1:25). Port 465 speaks TLS from the first byte,
 *  checking the certificate against PEPPERMINT_SMTP_TLS_NAME (default: the host); PEPPERMINT_SMTP_USER and
 *  PEPPERMINT_SMTP_PASSWORD log in with AUTH PLAIN. Throws the server's own reply on refusal. */
export async function send(m: Mail): Promise<void> {
  const [host, p] = (process.env.PEPPERMINT_SMTP ?? "127.0.0.1:25").split(":");
  const port = Number(p) || 25, user = process.env.PEPPERMINT_SMTP_USER, pass = process.env.PEPPERMINT_SMTP_PASSWORD ?? "";
  const sock = port === 465 ? connectTls({ host, port, servername: process.env.PEPPERMINT_SMTP_TLS_NAME ?? host }) : connect({ host, port });
  sock.setTimeout(30_000, () => sock.destroy(new Error("The mail server did not answer in time.")));
  let buf = "";
  const waiting: ((line: string) => void)[] = [];
  const failed = new Promise<never>((_, rej) => { sock.on("error", rej); sock.on("close", () => rej(new Error("The mail server closed the connection."))); });
  failed.catch(() => {});
  sock.on("data", d => {
    buf += d.toString("utf8");
    // a reply is complete at a line "250 text" (multi-line replies use "250-text" until the last)
    let m: RegExpExecArray | null;
    while ((m = /^(\d{3}) .*\r?\n/m.exec(buf))) { const end = m.index + m[0].length; const reply = buf.slice(0, end); buf = buf.slice(end); waiting.shift()?.(reply); }
  });
  const reply = () => Promise.race([new Promise<string>(r => waiting.push(r)), failed]);
  const step = async (line: string | null, ok: number) => {
    const r = reply();
    if (line !== null) sock.write(line + "\r\n");
    const got = await r;
    if (Number(got.slice(-200).match(/^(\d{3}) /m)?.[1]) !== ok) throw new Error(`Mail server: ${got.trim().split("\n").pop()}`);
  };
  try {
    await step(null, 220);
    await step(`EHLO ${m.from.split("@")[1] ?? "localhost"}`, 250);
    if (user) await step(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString("base64")}`, 235);
    await step(`MAIL FROM:<${m.from}>`, 250);
    await step(`RCPT TO:<${m.to}>`, 250);
    await step("DATA", 354);
    // dot-stuffing: a line starting with "." gets another one
    await step(mime(m).replace(/\r\n\./g, "\r\n..") + "\r\n.", 250);
    sock.write("QUIT\r\n");
  } finally { sock.end(); }
}
