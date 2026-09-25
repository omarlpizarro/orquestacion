import { describe, expect, it } from 'vitest';
import { copyResponseHeaders } from './mount-better-auth.js';

describe('copyResponseHeaders', () => {
  it('reenvía varios Set-Cookie como un array, no como un solo string con comas', () => {
    const headers = new Headers();
    headers.append('set-cookie', 'better-auth.session_token=abc; Path=/; HttpOnly');
    headers.append(
      'set-cookie',
      'better-auth.dont_remember=1; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT',
    );
    headers.set('content-type', 'application/json');

    const calls: Array<[string, string | string[]]> = [];
    copyResponseHeaders(headers, (name, value) => calls.push([name, value]));

    const setCookieCall = calls.find(([name]) => name === 'set-cookie');
    expect(setCookieCall?.[1]).toEqual([
      'better-auth.session_token=abc; Path=/; HttpOnly',
      'better-auth.dont_remember=1; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT',
    ]);
    // Una sola llamada para set-cookie, no una por cada valor ni una fusionada con otros headers.
    expect(calls.filter(([name]) => name === 'set-cookie')).toHaveLength(1);
  });

  it('reenvía el resto de los headers sin tocarlos', () => {
    const headers = new Headers({ 'content-type': 'application/json', 'x-custom': 'valor' });

    const calls: Array<[string, string | string[]]> = [];
    copyResponseHeaders(headers, (name, value) => calls.push([name, value]));

    expect(calls).toContainEqual(['content-type', 'application/json']);
    expect(calls).toContainEqual(['x-custom', 'valor']);
  });

  it('no llama a setHeader para set-cookie si no hay ninguna', () => {
    const headers = new Headers({ 'content-type': 'text/plain' });

    const calls: Array<[string, string | string[]]> = [];
    copyResponseHeaders(headers, (name, value) => calls.push([name, value]));

    expect(calls.some(([name]) => name === 'set-cookie')).toBe(false);
  });
});
