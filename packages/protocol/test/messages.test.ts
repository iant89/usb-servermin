import { describe, expect, it } from 'vitest';
import { MAX_FRAME_BYTES, ProtocolError, authenticationText, decode, encode, envelope, negotiateVersion, normalizeFingerprint } from '../src/index';

const AGENT = '7a1f6f5e-3c2b-4d1a-9e8f-0123456789ab';
const SERVER = '0b9c8d7e-6f5a-4b3c-8d2e-fedcba987654';
const frame = (o: unknown) => JSON.stringify(o);
const hb = (extra: Record<string, unknown> = {}) => ({ v: 1, id: 'm1', type: 'HEARTBEAT', payload: { sequence: 1, state: 'RUNNING', health: 'HEALTHY', uptimeSeconds: 5, ...extra } });

describe('protocol envelope', () => {
  it('decodes a valid message and keeps only known fields', () => {
    const m = decode(frame({ ...hb({ extra: 'dropped' }), correlationId: 'c-1', junk: true }), 'toManager');
    expect(m).toEqual({ v: 1, id: 'm1', type: 'HEARTBEAT', correlationId: 'c-1', payload: { sequence: 1, state: 'RUNNING', health: 'HEALTHY', uptimeSeconds: 5 } });
  });

  it.each([
    ['not JSON', 'nope', 'not JSON'],
    ['an array', '[]', 'JSON object'],
    ['another envelope version', frame({ ...hb(), v: 2 }), 'envelope version'],
    ['no id', frame({ ...hb(), id: undefined }), 'id must be'],
    ['a long id', frame({ ...hb(), id: 'x'.repeat(65) }), 'id must be'],
    ['an id with spaces', frame({ ...hb(), id: 'a b' }), 'id must be'],
    ['a bad correlation id', frame({ ...hb(), correlationId: 5 }), 'correlationId'],
    ['an unknown type', frame({ ...hb(), type: 'SHELL' }), 'Unknown message type'],
    ['a reserved type', frame({ ...hb(), type: 'COMMAND' }), 'not supported by protocol version 1'],
    ['no payload', frame({ ...hb(), payload: null }), 'payload must be an object'],
    ['a negative sequence', frame(hb({ sequence: -1 })), 'sequence'],
    ['a fractional uptime', frame(hb({ uptimeSeconds: 1.5 })), 'uptimeSeconds'],
    ['an unknown state', frame(hb({ state: 'DANCING' })), 'state must be one of'],
  ])('refuses %s', (_name, raw, message) => {
    expect(() => decode(raw, 'toManager')).toThrow(ProtocolError);
    expect(() => decode(raw, 'toManager')).toThrow(message);
  });

  it('enforces direction: an agent cannot send HELLO, a Manager cannot send HEARTBEAT', () => {
    expect(() => decode(frame({ v: 1, id: 'a', type: 'HELLO', payload: { managerVersion: '1', protocolVersions: [1], nonce: 'abc' } }), 'toManager')).toThrow('not allowed in this direction');
    expect(() => decode(frame(hb()), 'toAgent')).toThrow('not allowed in this direction');
  });

  it('refuses frames over the size limit without parsing them', () => {
    const big = frame({ ...hb(), pad: 'x'.repeat(MAX_FRAME_BYTES) });
    expect(() => decode(big, 'toManager')).toThrow(`larger than ${MAX_FRAME_BYTES}`);
  });

  it('never echoes frame content in an error', () => {
    try {
      decode(frame(hb({ state: '<script>secret</script>' })), 'toManager');
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('secret');
    }
  });

  it('refuses control characters in text', () => {
    const state = { v: 1, id: 's', type: 'ERROR', payload: { code: 'internal', message: 'line\u0000break' } };
    expect(() => decode(frame(state), 'toManager')).toThrow('message must be text');
  });

  it('validates AUTHENTICATE: UUIDs, a hex fingerprint or null, base64url signature', () => {
    const ok = { protocolVersion: 1, agentId: AGENT, serverId: SERVER, agentVersion: '1.0.0', keyFingerprint: 'a'.repeat(64), signature: 'c2ln' };
    expect(decode(frame({ v: 1, id: 'x', type: 'AUTHENTICATE', payload: ok }), 'toManager').payload).toEqual(ok);
    expect(decode(frame({ v: 1, id: 'x', type: 'AUTHENTICATE', payload: { ...ok, keyFingerprint: null } }), 'toManager').payload).toMatchObject({ keyFingerprint: null });
    for (const bad of [{ agentId: 'not-a-uuid' }, { keyFingerprint: 'AB' }, { signature: 'has space' }, { protocolVersion: 0 }])
      expect(() => decode(frame({ v: 1, id: 'x', type: 'AUTHENTICATE', payload: { ...ok, ...bad } }), 'toManager')).toThrow(ProtocolError);
  });

  it('bounds SERVER_STATE lists', () => {
    const state = {
      name: 'n',
      hostname: 'h',
      machineId: null,
      hardware: { vendor: null, product: null, board: null, fingerprint: null },
      os: { name: 'Ubuntu', id: 'ubuntu', version: '24.04', kernel: '6.8', arch: 'x64' },
      version: '1.0.0',
      state: 'RUNNING',
      health: 'HEALTHY',
      startedAt: new Date().toISOString(),
      uptimeSeconds: 1,
      capabilities: ['docker'],
      modules: [{ id: 'docker', version: '1', state: 'ACTIVE', health: 'HEALTHY', provides: ['docker.engine'], tags: [] }],
    };
    expect(decode(frame({ v: 1, id: 's', type: 'SERVER_STATE', payload: state }), 'toManager').payload).toEqual(state);
    expect(() => decode(frame({ v: 1, id: 's', type: 'SERVER_STATE', payload: { ...state, modules: Array(257).fill(state.modules[0]) } }), 'toManager')).toThrow('at most 256');
    expect(() => decode(frame({ v: 1, id: 's', type: 'SERVER_STATE', payload: { ...state, startedAt: 'yesterday' } }), 'toManager')).toThrow('ISO timestamp');
  });

  it('encode checks what it sends with the same rules', () => {
    expect(encode(envelope('HEARTBEAT_ACK', 'a1', { sequence: 3 }, 'm1'), 'toAgent')).toBe('{"v":1,"id":"a1","type":"HEARTBEAT_ACK","correlationId":"m1","payload":{"sequence":3}}');
    expect(() => encode(envelope('HEARTBEAT_ACK', 'a1', { sequence: -3 }), 'toAgent')).toThrow(ProtocolError);
    expect(() => encode(envelope('HEARTBEAT_ACK', 'a1', { sequence: 3 }), 'toManager')).toThrow('not allowed');
  });
});

describe('version negotiation and signing text', () => {
  it('picks the highest common version, or none', () => {
    expect(negotiateVersion([1, 2, 3], [1, 2])).toBe(2);
    expect(negotiateVersion([1])).toBe(1);
    expect(negotiateVersion([2, 3], [1])).toBeNull();
  });

  it('binds the signature to nonce, ids, Manager key and version', () => {
    const base = { nonce: 'n', agentId: AGENT, serverId: SERVER, keyFingerprint: 'f'.repeat(64), protocolVersion: 1 };
    const t = authenticationText(base);
    expect(t).toBe(`servermin-link-auth\nv1\nn\n${AGENT}\n${SERVER}\n${'f'.repeat(64)}`);
    for (const change of [{ nonce: 'm' }, { serverId: AGENT }, { keyFingerprint: null }, { protocolVersion: 2 }]) expect(authenticationText({ ...base, ...change })).not.toBe(t);
  });

  it('normalises fingerprints as people paste them', () => {
    const hex = 'ab'.repeat(32);
    expect(normalizeFingerprint(hex.toUpperCase().match(/../g)!.join(':'))).toBe(hex);
    expect(normalizeFingerprint(`sha256:${hex}`)).toBe(hex);
    expect(normalizeFingerprint('abc')).toBeNull();
  });
});
