/** Parsing of `ip -j` output, address validation and netplan generation. */

export interface Interface {
  name: string;
  index: number;
  mac: string | null;
  state: string;
  mtu: number;
  type: 'ethernet' | 'wireless' | 'loopback' | 'bridge' | 'virtual' | 'other';
  flags: string[];
  addresses: { family: 'ipv4' | 'ipv6'; address: string; prefix: number; dynamic: boolean; scope: string }[];
  stats: { rxBytes: number; txBytes: number; rxErrors: number; txErrors: number } | null;
}

export function classify(name: string, linkType: string, info?: string): Interface['type'] {
  if (linkType === 'loopback') return 'loopback';
  if (/^(wl|wlan)/.test(name)) return 'wireless';
  if (info === 'bridge' || /^(br|virbr|docker)\d*/.test(name)) return 'bridge';
  if (info || /^(veth|tun|tap|wg|vnet|lxc|tailscale|zt)/.test(name)) return 'virtual';
  return linkType === 'ether' ? 'ethernet' : 'other';
}

export function parseIpAddr(addrJson: string, linkJson?: string): Interface[] {
  const links = new Map<string, any>();
  if (linkJson) for (const l of JSON.parse(linkJson)) links.set(l.ifname, l);
  return JSON.parse(addrJson).map((i: any) => {
    const s = links.get(i.ifname)?.stats64;
    return {
      name: i.ifname,
      index: i.ifindex,
      mac: i.address && i.link_type !== 'loopback' ? i.address : null,
      state: (i.operstate ?? 'UNKNOWN').toLowerCase(),
      mtu: i.mtu,
      type: classify(i.ifname, i.link_type, i.linkinfo?.info_kind),
      flags: i.flags ?? [],
      addresses: (i.addr_info ?? []).map((a: any) => ({ family: a.family === 'inet' ? 'ipv4' : 'ipv6', address: a.local, prefix: a.prefixlen, dynamic: !!a.dynamic, scope: a.scope })),
      stats: s ? { rxBytes: s.rx.bytes, txBytes: s.tx.bytes, rxErrors: s.rx.errors, txErrors: s.tx.errors } : null,
    } satisfies Interface;
  });
}

export function parseRoutes(json: string) {
  return JSON.parse(json).map((r: any) => ({ destination: r.dst === 'default' ? 'default' : r.dst, gateway: r.gateway ?? null, device: r.dev, protocol: r.protocol ?? null, metric: r.metric ?? null, source: r.prefsrc ?? null }));
}

export function parseResolvectl(text: string) {
  const out: { interface: string | null; servers: string[] }[] = [];
  for (const line of text.split('\n')) {
    const m = /^(Global|Link \d+ \(([^)]+)\)):\s*(.*)$/.exec(line.trim());
    if (m) out.push({ interface: m[2] ?? null, servers: m[3].split(/\s+/).filter(Boolean) });
  }
  return out;
}

export function parseResolvConf(text: string) {
  return {
    servers: [...text.matchAll(/^nameserver\s+(\S+)/gm)].map((m) => m[1]),
    search: [...text.matchAll(/^search\s+(.+)$/gm)].flatMap((m) => m[1].split(/\s+/)),
  };
}

// ── Validation ──────────────────────────────────────────────────────────────────

export function isIPv4(ip: string) {
  const p = ip.split('.');
  return p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255 && String(Number(x)) === x);
}

export function isIPv6(ip: string) {
  if (!/^[0-9a-fA-F:]+$/.test(ip) || ip.split('::').length > 2) return false;
  const groups = ip.split(':');
  return ip.includes('::') ? groups.length <= 8 : groups.length === 8;
}

export function parseCidr(cidr: string): { ip: string; prefix: number; v6: boolean } | null {
  const [ip, p] = cidr.split('/');
  const prefix = Number(p);
  if (isIPv4(ip) && Number.isInteger(prefix) && prefix >= 1 && prefix <= 32) return { ip, prefix, v6: false };
  if (isIPv6(ip) && Number.isInteger(prefix) && prefix >= 1 && prefix <= 128) return { ip, prefix, v6: true };
  return null;
}

const v4num = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);

export function sameSubnet(ip: string, cidr: string) {
  const c = parseCidr(cidr);
  if (!c || c.v6 || !isIPv4(ip)) return true;
  const mask = c.prefix === 0 ? 0 : 2 ** 32 - 2 ** (32 - c.prefix);
  return (v4num(ip) & mask) >>> 0 === (v4num(c.ip) & mask) >>> 0;
}

export interface InterfaceConfig {
  mode: 'dhcp' | 'static';
  addresses?: string[];
  gateway?: string;
  dns?: string[];
  dhcp6?: boolean;
}

export function validateConfig(c: InterfaceConfig): string[] {
  const problems: string[] = [];
  if (c.mode !== 'dhcp' && c.mode !== 'static') problems.push('mode must be dhcp or static');
  if (c.mode === 'static') {
    if (!c.addresses?.length) problems.push('A static configuration needs at least one address');
    for (const a of c.addresses ?? []) if (!parseCidr(a)) problems.push(`"${a}" is not an address with prefix, e.g. 192.168.1.10/24`);
    if (c.gateway) {
      if (!isIPv4(c.gateway) && !isIPv6(c.gateway)) problems.push(`Gateway "${c.gateway}" is not an IP address`);
      else if (isIPv4(c.gateway) && !(c.addresses ?? []).some((a) => sameSubnet(c.gateway!, a))) problems.push('The gateway is not inside any of the configured subnets');
    }
  }
  for (const d of c.dns ?? []) if (!isIPv4(d) && !isIPv6(d)) problems.push(`DNS server "${d}" is not an IP address`);
  if ((c.dns ?? []).length > 3) problems.push('Use at most three DNS servers');
  return problems;
}

/** Renders the netplan file that Server Control owns (90-servermin.yaml). */
export function renderNetplan(configs: Record<string, InterfaceConfig>): string {
  const lines = ['# Managed by Server Control. Changes made here are overwritten.', 'network:', '  version: 2', '  ethernets:'];
  const names = Object.keys(configs).sort();
  if (!names.length) return ['# Managed by Server Control.', 'network:', '  version: 2', ''].join('\n');
  for (const name of names) {
    if (!/^[A-Za-z0-9_.:-]{1,15}$/.test(name)) throw new Error(`Invalid interface name ${name}`);
    const c = configs[name];
    lines.push(`    ${name}:`);
    if (c.mode === 'dhcp') {
      lines.push('      dhcp4: true', `      dhcp6: ${c.dhcp6 ? 'true' : 'false'}`);
    } else {
      lines.push('      dhcp4: false', '      dhcp6: false', '      addresses:', ...(c.addresses ?? []).map((a) => `        - "${a}"`));
      if (c.gateway) lines.push('      routes:', `        - to: ${isIPv6(c.gateway) ? '"::/0"' : 'default'}`, `          via: "${c.gateway}"`);
    }
    if (c.dns?.length) lines.push('      nameservers:', '        addresses:', ...c.dns.map((d) => `          - "${d}"`));
  }
  return lines.join('\n') + '\n';
}
