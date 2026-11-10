# ADR-003: Server and agent identity

- Status: **Accepted**
- Date: 2026-11-10 (Phase 1)

## Context

A Manager needs a key for each server that survives a hostname change, an OS re-image, an agent
reinstall and, because portable installations remain supported, the same disk booting on different
hardware. The audit found that nothing in the current system is such a key: the hostname is
editable, `/etc/machine-id` belongs to the OS installation and moves with a portable disk, and DMI
serial numbers are readable only by root.

## Decision

1. An agent has two random UUIDs, created on first start and stored in
   `<agent.stateDir>/identity.json` (mode 0600, directory 0700, written atomically):
   - **Agent ID** identifies this agent installation and never changes.
   - **Server ID** identifies the server. It is created locally so that an unregistered agent
     can already report it; a Manager may replace it at registration to attach a reinstalled agent
     to an existing server (`IdentityStore.setServerId`).
2. Hostname, machine id and a hardware description (vendor, product, board, and a hash of them) are
   **reported attributes**, never keys.
3. `agent.stateDir` defaults to `<paths.data>/agent`, so the identity travels with the data: a
   portable installation booted on other hardware is the same server, and the changed hardware
   attributes tell a Manager that it moved. Pointing `agent.stateDir` at a disk of the machine
   gives the opposite behaviour.
4. The ids are identifiers, **not secrets**. They are shown to every signed-in user and must never
   be accepted as proof of identity; authentication of an agent to a Manager uses a key pair
   (Phase 4).
5. A damaged identity file is never overwritten silently. It is kept as
   `identity.json.damaged-<time>`, a new identity is created so the server keeps working on its
   own, and an error is logged and shown to administrators, because a Manager will treat the
   server as new.

## Consequences

- Copying the data directory to a second machine (a restored backup, a cloned disk) creates two
  agents with the same identity. A Manager must detect two live connections with one agent id
  (Phase 3) and the backup documentation says to delete `agent/identity.json` on a clone.
- The hardware fingerprint describes the model, not the unit: two identical machines share it.
  Distinguishing them needs a root-only read through the privilege helper, which is deferred until
  a feature needs it.
- Choosing availability over identity continuity in point 5 means a corrupted file costs a
  re-registration, not an outage.

## Alternatives considered

- **Machine id as the key.** Changes on re-image, is duplicated by cloned VM images, and moves with
  a portable disk.
- **Manager-assigned server id only.** An unregistered agent could not report one, and the Phase 1
  exit criteria and the local tools need it before any Manager exists.
- **Refusing to start with a damaged identity.** Turns a damaged 150-byte file into loss of the
  local web interface and every module.
