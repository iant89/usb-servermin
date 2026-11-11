import os from 'node:os';
import type { HealthStatus, Logger, ModuleState } from '@servermin/sdk';
import { osRelease } from '../system/host-info';
import { CORE_VERSION } from '../version';
import { AgentKey } from './agent-key';
import { IdentityStore, readHardwareIdentity, readMachineId, type AgentIdentity, type HardwareIdentity } from './identity';
import type { LinkStatus } from './manager-link';

export type AgentState = 'STARTING' | 'RUNNING' | 'STOPPING';

/** What the agent needs to know about a module to describe itself. */
export interface AgentModuleInfo {
  id: string;
  version: string;
  state: ModuleState;
  health: HealthStatus;
  /** Services the module provides to others (`docker.engine`). */
  provides: string[];
  /** Descriptive tags from the manifest (`containers`, `smart`). */
  tags: string[];
}

export interface AgentReport {
  agentId: string;
  serverId: string;
  /** Display name: the server name from Settings, the hostname by default. */
  name: string;
  hostname: string;
  machineId: string | null;
  hardware: HardwareIdentity;
  os: { name: string; id: string | null; version: string | null; kernel: string; arch: string };
  /** Agent version. */
  version: string;
  state: AgentState;
  health: HealthStatus;
  startedAt: string;
  uptimeSeconds: number;
  /** What this server can do right now: working modules and the services they provide, sorted. */
  capabilities: string[];
  modules: AgentModuleInfo[];
  /** SHA-256 of the agent's public key: what an administrator compares when enrolling this agent. */
  keyFingerprint: string;
  /** Connection to a Servermin Manager. */
  manager: LinkStatus;
}

/**
 * Capabilities come only from modules that are ACTIVE and whose own health check does not report
 * ERROR or OFFLINE (the Docker module is active but useless while the engine is down). The list
 * shrinks when a module stops or fails and grows when one is installed; nothing here names a
 * specific module.
 */
export function deriveCapabilities(modules: AgentModuleInfo[]): string[] {
  const out = new Set<string>();
  for (const m of modules) {
    if (m.state !== 'ACTIVE' || m.health === 'ERROR' || m.health === 'OFFLINE') continue;
    out.add(m.id);
    for (const s of m.provides) out.add(s);
  }
  return [...out].sort();
}

export interface AgentServiceDeps {
  stateDir: string;
  logger: Logger;
  modules(): AgentModuleInfo[];
  health(): HealthStatus;
  serverName(): string;
  /** Root of the file system that host facts are read from. Tests only. */
  hostRoot?: string;
  /** Status of the connection to a Manager; absent while none is wired up. */
  link?(): LinkStatus;
}

const NO_LINK: LinkStatus = { configured: false, url: null, state: 'DISABLED', connectedSince: null, lastConnectedAt: null, lastError: null, lastErrorAt: null, attempts: 0, nextAttemptAt: null, protocolVersion: null };

/**
 * The Agent side of Servermin (ADR-001): this server's identity and its description of itself.
 * It runs inside the core and works without any Manager; the connection to one is added on top.
 */
export class AgentService {
  private store: IdentityStore;
  private identityValue: AgentIdentity | null = null;
  private keyValue: AgentKey | null = null;
  private startedAt = Date.now();
  state: AgentState = 'STARTING';

  constructor(private readonly d: AgentServiceDeps) {
    this.store = new IdentityStore(d.stateDir);
  }

  /** Loads or creates the identity. Returns details when a damaged identity had to be replaced. */
  start(): { replaced?: { keptAs: string; reason: string }; keyReplaced?: { keptAs: string; reason: string } } {
    const r = this.store.load();
    this.identityValue = r.identity;
    this.startedAt = Date.now();
    if (r.replaced) this.d.logger.error('The agent identity file was unreadable and has been replaced; a Manager will see this server as new', { ...r.replaced, agentId: r.identity.agentId });
    else if (r.created) this.d.logger.info('Created agent identity', { agentId: r.identity.agentId, serverId: r.identity.serverId });
    const k = AgentKey.load(this.d.stateDir);
    this.keyValue = k.key;
    if (k.replaced) this.d.logger.error('The agent key file was unreadable and has been replaced; a Manager will refuse this agent until the new key is enrolled', { ...k.replaced, keyFingerprint: k.key.fingerprint });
    else if (k.created) this.d.logger.info('Created agent key', { keyFingerprint: k.key.fingerprint });
    this.d.logger.info(`Agent ${CORE_VERSION} starting`, { agentId: r.identity.agentId, serverId: r.identity.serverId, hostname: os.hostname() });
    return { replaced: r.replaced, keyReplaced: k.replaced };
  }

  get identity(): AgentIdentity {
    if (!this.identityValue) throw new Error('Agent identity is not loaded');
    return this.identityValue;
  }

  get key(): AgentKey {
    if (!this.keyValue) throw new Error('Agent key is not loaded');
    return this.keyValue;
  }

  /** Adopts the server id a Manager assigned (ADR-003). */
  adoptServerId(serverId: string) {
    this.identityValue = this.store.setServerId(this.identity, serverId);
  }

  setState(state: AgentState) {
    if (state === this.state) return;
    this.d.logger.info(`Agent ${state.toLowerCase()}`);
    this.state = state;
  }

  capabilities(): string[] {
    return deriveCapabilities(this.d.modules());
  }

  async report(): Promise<AgentReport> {
    const rel = await osRelease();
    const modules = this.d.modules().sort((a, b) => a.id.localeCompare(b.id));
    const root = this.d.hostRoot ?? '/';
    return {
      agentId: this.identity.agentId,
      serverId: this.identity.serverId,
      name: this.d.serverName(),
      hostname: os.hostname(),
      machineId: readMachineId(root),
      hardware: readHardwareIdentity(root),
      os: { name: rel.PRETTY_NAME ?? `${os.type()} ${os.release()}`, id: rel.ID ?? null, version: rel.VERSION_ID ?? null, kernel: os.release(), arch: os.arch() },
      version: CORE_VERSION,
      state: this.state,
      health: this.d.health(),
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      capabilities: deriveCapabilities(modules),
      modules,
      keyFingerprint: this.key.fingerprint,
      manager: this.d.link?.() ?? NO_LINK,
    };
  }
}
