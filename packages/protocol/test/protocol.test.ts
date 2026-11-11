import { describe, expect, it } from 'vitest';
import { MAX_FRAME_BYTES, MESSAGE_TYPES, RESERVED_TYPES, ProtocolError, authSigningInput, createMessage, decode, encode, negotiateVersion, normalizeFingerprint } from '../src/index';

const AGENT = '3f0e7a52-4a67-4c0e-9d6b-0f3c5a1b2c3d';
const SERVER = '0b9f3c1e-2d4a-4f6b-8c7d-9e0f1a2b3c4d';
const NONCE = Buffer.alloc(32, 7).toString('base64');
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof ProtocolError ? `${e.code}: ${e.message}` : `other: ${e}`;
  }
  return 'accepted';
};

describe('protocol messages', () => {
  it('round-trips every implemented message with an id, a timestamp and an optional correlation id', () => {
    const samples = [
      createMessage('HELLO', { versions: [1], nonce: NONCE, manager: { version: '1.0.0' } }),
      createMessage('AUTHENTICATION', { agentId: AGENT, serverId: SERVER, version: 1, signature: Buffer.alloc(64).toString('base64') }),
      createMessage('AUTHENTICATED', { serverId: SERVER, heartbeatIntervalMs: 15000, heartbeatTimeoutMs: 60000 }, 'abc'),
      createMessage('ERROR', { code: 'unauthorized', message: 'no' }),
      createMessage('HEARTBEAT', { seq: 3 }),
      createMessage('SERVER_STATE', { name: 'Saturn', hostname: 'saturn', agentVersion: '1.0.0', os: 'Ubuntu 24.04', health: 'HEALTHY', state: 'RUNNING' }),
      createMessage('CAPABILITIES', { capabilities: ['docker', 'docker.engine'] }),
    ];
    for (const m of samples) expect(decode(encode(m))).toEqual(m);
    expect(new Set(samples.map((m) => m.id)).size).toBe(samples.length);
    expect(decode(Buffer.from(encode(samples[2]))).correlationId).toBe('abc');
  });

  it('names all ten roadmap message types and refuses the ones no phase has implemented yet', () => {
    for (const t of ['HEARTBEAT', 'AUTHENTICATION', 'SERVER_STATE', 'CAPABILITIES', 'METRIC', 'EVENT', 'COMMAND', 'COMMAND_RESULT', 'LOG', 'MODULE_STATE']) expect(MESSAGE_TYPES).toContain(t);
    for (const t of RESERVED_TYPES) expect(code(() => decode(encode(createMessage(t, {}))))).toBe(`unsupported: ${t} is not supported by this version`);
  });

  const valid = () => JSON.parse(encode(createMessage('HEARTBEAT', { seq: 1 })));
  it.each([
    ['not JSON', '{nope', 'malformed: Frame is not JSON'],
    ['an array', '[]', 'malformed: Message must be an object'],
    ['a string', '"HEARTBEAT"', 'malformed: Message must be an object'],
    ['no version', JSON.stringify({ ...valid(), v: undefined }), 'malformed: Missing protocol version'],
    ['a version of the wrong type', JSON.stringify({ ...valid(), v: '1' }), 'malformed: Missing protocol version'],
    ['no id', JSON.stringify({ ...valid(), id: '' }), 'malformed: Missing message id'],
    ['an id with markup', JSON.stringify({ ...valid(), id: '<script>' }), 'malformed: Missing message id'],
    ['an unknown type', JSON.stringify({ ...valid(), type: 'EXEC' }), 'unsupported: Unknown message type'],
    ['a prototype key as type', JSON.stringify({ ...valid(), type: 'constructor' }), 'unsupported: Unknown message type'],
    ['a bad timestamp', JSON.stringify({ ...valid(), ts: 'yesterday' }), 'malformed: Missing timestamp'],
    ['a bad correlation id', JSON.stringify({ ...valid(), correlationId: 5 }), 'malformed: Invalid correlation id'],
    ['no payload', JSON.stringify({ ...valid(), payload: null }), 'malformed: Missing payload'],
    ['a payload array', JSON.stringify({ ...valid(), payload: [1] }), 'malformed: Missing payload'],
    ['a negative sequence', JSON.stringify({ ...valid(), payload: { seq: -1 } }), 'malformed: Invalid HEARTBEAT: seq'],
    ['a fractional sequence', JSON.stringify({ ...valid(), payload: { seq: 1.5 } }), 'malformed: Invalid HEARTBEAT: seq'],
  ])('rejects %s', (_name, raw, expected) => {
    expect(code(() => decode(raw))).toBe(expected);
  });

  it.each([
    ['AUTHENTICATION', { agentId: 'saturn', serverId: SERVER, version: 1, signature: 'AAAA' }, 'agentId'],
    ['AUTHENTICATION', { agentId: AGENT, serverId: SERVER, version: 1, signature: 'not base64!' }, 'signature'],
    ['AUTHENTICATION', { agentId: AGENT, serverId: SERVER, version: 1, signature: 'A'.repeat(200) }, 'signature'],
    ['HELLO', { versions: [], nonce: NONCE, manager: { version: '1' } }, 'versions'],
    ['HELLO', { versions: [1], nonce: 'short', manager: { version: '1' } }, 'nonce'],
    ['SERVER_STATE', { name: '', hostname: 'h', agentVersion: '1', os: 'x', health: 'HEALTHY', state: 'RUNNING' }, 'name'],
    ['SERVER_STATE', { name: 'n', hostname: 'h', agentVersion: '1', os: 'x', health: 'GREAT', state: 'RUNNING' }, 'health'],
    ['SERVER_STATE', { name: 'bad\u0000', hostname: 'h', agentVersion: '1', os: 'x', health: 'HEALTHY', state: 'RUNNING' }, 'name'],
    ['CAPABILITIES', { capabilities: ['Docker Engine'] }, 'capabilities'],
    ['CAPABILITIES', { capabilities: Array(501).fill('docker') }, 'capabilities'],
    ['CAPABILITIES', { capabilities: 'docker' }, 'capabilities'],
    ['ERROR', { code: 'whatever', message: 'x' }, 'code'],
  ])('rejects a %s with a bad %j', (type, payload, field) => {
    expect(code(() => decode(JSON.stringify({ ...valid(), type, payload })))).toBe(`malformed: Invalid ${type}: ${field}`);
  });

  it('refuses a frame over the size limit before parsing it', () => {
    expect(code(() => decode(JSON.stringify({ ...valid(), pad: 'x'.repeat(MAX_FRAME_BYTES) })))).toBe('malformed: Frame too large');
  });

  it('drops fields it does not know from the envelope', () => {
    const m = decode(JSON.stringify({ ...valid(), admin: true }));
    expect(Object.keys(m).sort()).toEqual(['id', 'payload', 'ts', 'type', 'v']);
  });
});

describe('version negotiation', () => {
  it('picks the highest common version, or none', () => {
    expect(negotiateVersion([1], [1])).toBe(1);
    expect(negotiateVersion([1, 2, 3], [2, 1])).toBe(2);
    expect(negotiateVersion([2, 3], [1])).toBeNull();
    expect(negotiateVersion([])).toBeNull();
  });
});

describe('authentication signing input', () => {
  const base = { nonce: NONCE, agentId: AGENT, serverId: SERVER, version: 1, tlsFingerprint: 'ab'.repeat(32) };
  it('changes when any bound value changes', () => {
    const ref = authSigningInput(base).toString('hex');
    for (const change of [{ nonce: Buffer.alloc(32, 8).toString('base64') }, { agentId: SERVER }, { serverId: AGENT }, { version: 2 }, { tlsFingerprint: 'cd'.repeat(32) }, { tlsFingerprint: '' }])
      expect(authSigningInput({ ...base, ...change }).toString('hex')).not.toBe(ref);
    expect(authSigningInput({ ...base }).toString('hex')).toBe(ref);
  });

  it('cannot be confused across fields', () => {
    // Fields are UUIDs, base64 and hex: none can contain the separator.
    expect(authSigningInput(base).toString().split('\n')).toHaveLength(6);
  });
});

describe('certificate fingerprints', () => {
  it('accepts the usual spellings and rejects everything else', () => {
    const hex = 'ab'.repeat(32);
    expect(normalizeFingerprint(hex)).toBe(hex);
    expect(normalizeFingerprint(hex.toUpperCase().match(/../g)!.join(':'))).toBe(hex);
    expect(normalizeFingerprint(`SHA256:${hex}`)).toBe(hex);
    expect(normalizeFingerprint(`sha-256=${hex}`)).toBe(hex);
    expect(normalizeFingerprint('ab'.repeat(20))).toBeNull();
    expect(normalizeFingerprint('zz'.repeat(32))).toBeNull();
    expect(normalizeFingerprint('')).toBeNull();
  });
});
