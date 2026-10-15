import { describe, expect, it } from 'vitest';
import { maskRecipient, normalisePhone, sendSms, smsText, type SmsSettings } from './channels.ts';

const base: SmsSettings = { enabled: true, provider: 'android-gateway', url: 'http://192.168.1.50:8080/', username: 'sms', secretRef: 'TEST_SMS_KEY', sender: '', contentType: 'json', bodyTemplate: '{"to": "{to}", "message": "{text}"}', authHeader: 'Authorization: Bearer {key}' };
function capture() {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{"SMSMessageData":{"Recipients":[{"status":"Success"}]}}', { status: 200 }); }) as unknown as typeof fetch;
  return { calls, f };
}

describe('SMS gateways', () => {
  process.env.SECRET_TEST_SMS_KEY = 'k3y"x';
  it('Android phone gateway: POST /message with basic authentication', async () => {
    const { calls, f } = capture();
    await sendSms(base, '+254 712 345 678', 'Door offline: 101', f);
    expect(calls[0]!.url).toBe('http://192.168.1.50:8080/message');
    expect((calls[0]!.init.headers as any).authorization).toBe(`Basic ${Buffer.from('sms:k3y"x').toString('base64')}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ message: 'Door offline: 101', phoneNumbers: ['+254712345678'] });
  });
  it("Africa's Talking: form body and apiKey header", async () => {
    const { calls, f } = capture();
    await sendSms({ ...base, provider: 'africastalking', url: '', username: 'khotel', sender: 'KHOTEL' }, '+237600000001', 'Disk low', f);
    expect(calls[0]!.url).toBe('https://api.africastalking.com/version1/messaging');
    expect((calls[0]!.init.headers as any).apiKey).toBe('k3y"x');
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({ username: 'khotel', to: '+237600000001', message: 'Disk low', from: 'KHOTEL' });
  });
  it('custom HTTP: template values are escaped for JSON', async () => {
    const { calls, f } = capture();
    await sendSms({ ...base, provider: 'http', url: 'https://sms.example/send' }, '+33612345678', 'He said "hi"\nbye', f);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ to: '+33612345678', message: 'He said "hi"\nbye' });
    expect((calls[0]!.init.headers as any).authorization).toBe('Bearer k3y"x');
  });
  it('refuses numbers that are not international, shortens long texts, masks the log', async () => {
    expect(() => normalisePhone('0712345678')).toThrow(/international/);
    expect(smsText('x'.repeat(400)).length).toBe(300);
    expect(maskRecipient('email', 'duty@khb.test')).toBe('du***@khb.test');
    expect(maskRecipient('sms', '+237600000001')).toBe('+237*****001');
  });
  it('a gateway error is reported', async () => {
    const f = (async () => new Response('bad', { status: 401 })) as unknown as typeof fetch;
    await expect(sendSms(base, '+254712345678', 'x', f)).rejects.toThrow(/401/);
  });
});
