import os from 'node:os';
import type { HealthStatus, Logger, ModuleState } from '@servermin/sdk';
import { osRelease } from '../system/host-info';
import { CORE_VERSION } from '../version';
import { readFileSync } from 'node:fs';
import { LINK_PATH, PROTOCOL_VERSIONS, type ServerStatePayload } from '@servermin/protocol';
import { loadAgentKey } from './agent-key';
import { ManagerLink, linkUrl, type ManagerLinkOptions, type ManagerLinkStatus } from './manager-link';
import { IdentityStore, readHardwareIdentity, readMachineId, type AgentIdentity, type HardwareIdentity } from './identity';

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
  /** Told about every change of the Manager connection. */
  onLinkChange?(status: ManagerLinkStatus): void;
}

export interface ManagerLinkConfig {
  url: string | null;
  fingerprint: string | null;
  /** Path of a PEM file. */
  ca: string | null;
}

const DISABLED_LINK: ManagerLinkStatus = { url: null, state: 'DISABLED', connectedSince: null, lastConnectedAt: null, lastError: null, failedAttempts: 0, nextAttemptAt: null, sessionId: null, protocolVersion: null, managerKeyFingerprint: null };

/**
 * The Agent side of Servermin (ADR-001): this server's identity and its description of itself.
 * It runs inside the core and works without any Manager; the connection to one is added on top.
 */
export class AgentService {
  private store: IdentityStore;
  private identityValue: AgentIdentity | null = null;
  private startedAt = Date.now();
  private link: ManagerLink | null = null;
  private linkProblem: string | null = null;
  state: AgentState = 'STARTING';

  constructor(private readonly d: AgentServiceDeps) {
    this.store = new IdentityStore(d.stateDir);
  }

  /** Loads or creates the identity. Returns details when a damaged identity had to be replaced. */
  start(): { replaced?: { keptAs: string; reason: string } } {
    const r = this.store.load();
    this.identityValue = r.identity;
    this.startedAt = Date.now();
    if (r.replaced) this.d.logger.error('The agent identity file was unreadable and has been replaced; a Manager will see this server as new', { ...r.replaced, agentId: r.identity.agentId });
    else if (r.created) this.d.logger.info('Created agent identity', { agentId: r.identity.agentId, serverId: r.identity.serverId });
    this.d.logger.info(`Agent ${CORE_VERSION} starting`, { agentId: r.identity.agentId, serverId: r.identity.serverId, hostname: os.hostname() });
    return { replaced: r.replaced };
  }

  get identity(): AgentIdentity {
    if (!this.identityValue) throw new Error('Agent identity is not loaded');
    return this.identityValue;
  }

  setState(state: AgentState) {
    if (state === this.state) return;
    this.d.logger.info(`Agent ${state.toLowerCase()}`);
    this.state = state;
  }

  /**
   * Connects to the configured Manager (ADR-002), or does nothing when none is configured: an
   * agent without a Manager is the stand-alone product. Problems are reported in `linkStatus()`
   * and the log; they never stop the agent.
   */
  startLink(config: ManagerLinkConfig, tuning: Pick<ManagerLinkOptions, 'backoff' | 'connectTimeoutMs' | 'stableAfterMs'> = {}): ManagerLinkStatus {
    if (this.link || !config.url) return this.linkStatus();
    let ca: string | null = null;
    try {
      if (config.ca && !config.fingerprint) ca = readFileSync(config.ca, 'utf8');
    } catch (e) {
      this.linkProblem = `Cannot read agent.manager.ca (${config.ca}): ${(e as Error).message}`;
      this.d.logger.error(this.linkProblem);
      return this.linkStatus();
    }
    const key = loadAgentKey(this.store.dir);
    if (key.replaced) this.d.logger.error('The agent key was unreadable and has been replaced; the Manager will refuse this agent until it is registered again', key.replaced);
    else if (key.created) this.d.logger.info('Created the agent key');
    this.link = new ManagerLink({
      url: linkUrl(config.url, LINK_PATH),
      fingerprint: config.fingerprint,
      ca,
      key: key.key,
      identity: () => this.identity,
      version: CORE_VERSION,
      heartbeat: () => ({ state: this.state, health: this.d.health(), uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000) }),
      capabilities: () => [this.state, ...this.capabilities()],
      report: () => this.serverState(),
      logger: this.d.logger,
      onChange: (status) => this.d.onLinkChange?.(status),
      ...tuning,
    });
    this.d.logger.info('Connecting to the Manager', { url: config.url, pinned: !!config.fingerprint, protocolVersions: PROTOCOL_VERSIONS });
    this.link.start();
    return this.linkStatus();
  }

  async stopLink() {
    await this.link?.stop();
  }

  linkStatus(): ManagerLinkStatus {
    return this.link ? this.link.status() : { ...DISABLED_LINK, lastError: this.linkProblem };
  }

  /** The report as the protocol carries it: without the ids, which the connection already established. */
  async serverState(): Promise<ServerStatePayload> {
    const { agentId: _a, serverId: _s, ...rest } = await this.report();
    return rest;
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
    };
  }
}
