import { describe, expect, it } from 'vitest';
import { contentMd5, sign, stringToSign, canonicalizedResource } from './signing.ts';

// Worked examples from ASSA ABLOY Web API 61 1100 080 rev 74, §7.1.3 and §7.1.4.
describe('Visionline request signing (vendor test vectors)', () => {
  const accessKey = 'AQIDBAUGBwg=';

  it('§7.1.3 signs a GET without body, sorting query parameters', () => {
    const input = { method: 'GET', date: 'Wed, 16 Jan 2013 15:23:02 +0000', url: '/api/v1/cards?validTime=20130105T1200&cardHolder=jdoe' };
    const s = stringToSign(input);
    expect(s).toBe('GET\n\n\nWed, 16 Jan 2013 15:23:02 +0000\n/api/v1/cards?cardHolder=jdoe&validTime=20130105T1200');
    expect(Buffer.byteLength(s, 'utf8')).toBe(91);
    expect(sign(accessKey, input)).toBe('NBtebtGX1NTbshSOZ5CeKu7ato4=');
  });

  it('§7.1.4 signs a PUT with body and X-Aah-Date', () => {
    const body = '{\n  "surname": "Kierkegaard",\n  "givenName": "Søren",\n  "userGroup": "Guests in suite 102"\n}';
    expect(Buffer.byteLength(body, 'utf8')).toBe(93);
    const md5 = contentMd5(body);
    expect(md5).toBe('lDEgtyndZjeGQSrDUs69Ew==');
    const input = {
      method: 'PUT', contentMd5: md5, contentType: 'application/json; charset=utf-8',
      date: 'Wed, 4 Jan 1995 03:23:02 +0500', xAahDate: 'Wed, 16 Jan 2013 15:23:02 +0000', url: '/api/v1/users/skierkegaard',
    };
    const s = stringToSign(input);
    expect(Buffer.byteLength(s, 'utf8')).toBe(131);
    expect(sign(accessKey, input)).toBe('c/6u8X+ckO12cBD3PY9wdzS0Mf4=');
  });

  it('keeps a URL without query unchanged', () => {
    expect(canonicalizedResource('/api/v1/doors/101')).toBe('/api/v1/doors/101');
  });

  // Independent worked example from ASSA ABLOY's official Visionline Postman collection/environment
  // (exported 2020-04-22): a real POST /cards?action=encode&encoder=fd1 request, with the session access
  // key, Content-MD5, x-aah-date and the signature their own tooling produced. Confirms our signing is
  // byte-identical to the vendor's reference implementation, including the hex access key used as UTF-8.
  it("matches ASSA ABLOY's Postman reference signature", () => {
    const accessKeyHex = '7a5d7b5fe22c414fb2725db676582dae';
    const input = {
      method: 'POST', contentMd5: 'cDRYq839BlgtCHEsFTEnPw==', contentType: 'application/json;charset=UTF-8',
      xAahDate: 'Thu, 02 Apr 2020 11:17:35 GMT', url: '/api/v1/cards?action=encode&encoder=fd1',
    };
    expect(stringToSign(input)).toBe(
      'POST\ncDRYq839BlgtCHEsFTEnPw==\napplication/json;charset=UTF-8\n\nx-aah-date:Thu, 02 Apr 2020 11:17:35 GMT\n/api/v1/cards?action=encode&encoder=fd1',
    );
    expect(sign(accessKeyHex, input)).toBe('vieKnAFG4AxrxeyVO9N/7Qrtfgw=');
  });
});
