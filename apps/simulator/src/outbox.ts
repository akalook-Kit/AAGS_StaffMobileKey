import type { FastifyInstance } from 'fastify';
import { SMTPServer } from 'smtp-server';

/**
 * Test sinks for the platform's alert messages (2.7): an SMTP server that accepts any mail, and SMS gateways in
 * the formats the platform speaks ("SMS Gateway for Android" local server, Africa's Talking). Nothing is sent
 * anywhere; GET /sim/outbox shows what arrived. Never part of a production installation.
 */
export interface OutboxItem { at: string; to: string[]; subject?: string; text: string; via: string; auth?: string }
export function registerOutbox(app: FastifyInstance, log: (m: string) => void, smtpPort: number, smsUser: string, smsPassword: string) {
  const items: OutboxItem[] = [];
  const keep = (i: OutboxItem) => { items.unshift(i); items.length = Math.min(items.length, 200); log(`OUTBOX ${i.via} to ${i.to.join(', ')}: ${(i.subject ?? i.text).slice(0, 80)}`); };

  const smtp = new SMTPServer({
    authOptional: true, disabledCommands: ['STARTTLS'], logger: false,
    onAuth(auth, _s, cb) { cb(null, { user: auth.username }); },
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (d: Buffer) => { raw += d.toString('utf8'); });
      stream.on('end', () => {
        const subject = /^Subject: (.*)$/m.exec(raw)?.[1]?.trim();
        const body = raw.split(/\r?\n\r?\n/).slice(1).join('\n\n');
        keep({ at: new Date().toISOString(), to: session.envelope.rcptTo.map((r) => r.address), subject, text: body.slice(0, 2000), via: 'email', auth: session.user ? String(session.user) : undefined });
        cb();
      });
    },
  });
  smtp.listen(smtpPort, '0.0.0.0', () => log(`SMTP test sink on port ${smtpPort}`));

  app.post('/sms-gateway/message', async (req, reply) => {
    const auth = Buffer.from(String(req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
    if (auth !== `${smsUser}:${smsPassword}`) return reply.code(401).send({ message: 'Unauthorized' });
    const b = req.body as { message?: string; phoneNumbers?: string[] };
    if (!b?.message || !Array.isArray(b.phoneNumbers) || !b.phoneNumbers.length) return reply.code(400).send({ message: 'message and phoneNumbers are required' });
    keep({ at: new Date().toISOString(), to: b.phoneNumbers, text: b.message, via: 'sms (android gateway)' });
    return reply.code(202).send({ id: `sim-${items.length}`, state: 'Pending' });
  });
  app.post('/sms-at/version1/messaging', async (req, reply) => {
    if (req.headers.apikey !== smsPassword) return reply.code(401).send('The supplied authentication is invalid');
    const b = req.body as Record<string, string>;
    keep({ at: new Date().toISOString(), to: String(b.to ?? '').split(','), text: String(b.message ?? ''), via: "sms (africa's talking)" });
    return { SMSMessageData: { Message: 'Sent to 1/1', Recipients: [{ status: 'Success', number: b.to }] } };
  });
  app.get('/sim/outbox', async () => items);
  app.delete('/sim/outbox', async () => { items.length = 0; return { ok: true }; });
  return { close: () => new Promise<void>((r) => smtp.close(() => r())) };
}
