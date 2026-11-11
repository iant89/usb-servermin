# ADR-004: Server registration

- Status: **Accepted**
- Date: 2026-11-11 (Phase 4)

## Context

Phase 3 lets an enrolled agent connect, but enrolling one means copying its agent id and public
key into `PUT /servers/:id/agent` and editing `agent.manager` in the root-owned
`/etc/servermin/config.json`, then restarting the agent (known issues 8 and 16). The roadmap's exit
criterion for Phase 4 is: code → install → `servermin-agent register CODE` → approve → managed.

## Decision

1. **Codes.** An administrator with `servers.manage` creates a code (`POST
   /registration-codes`). A code is 125 random bits written as `SMR-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`
   in Crockford base32. Input is forgiving: case, dashes, spaces, and `O`/`I`/`L` for `0`/`1` are
   all accepted. The Manager stores only a SHA-256 hash. Codes expire (60 minutes by default, at
   most 7 days), work once and can be revoked. A code may be **bound to an existing server**, for a
   reinstalled machine. It may also **approve itself**, for automated provisioning. The answer
   includes the exact command to run on the server, with the Manager's certificate fingerprint.
2. **Registering.** `servermin-agent register CODE --manager URL --fingerprint SHA256` runs as
   root on the server.
   - It reads the agent's identity and **public** key from the state directory, never the private
     key, and posts them with the code to the public `POST /registrations`.
   - With `--fingerprint` the certificate is checked **before the request body is written**, so a
     code never reaches anyone but that Manager. `--ca FILE` and system trust also work. Plain HTTP
     needs `--insecure`.
   - An untrusted certificate is refused, and the error shows the fingerprint seen so it can be
     compared with what the Manager printed.
   - The Manager returns its own fingerprint, and a mismatch with the one seen (TLS terminated in
     between) is refused, since agent authentication would fail anyway.
3. **Runtime configuration without a restart.** On success the command writes
   `<stateDir>/manager.json` (0600, owned by the agent's account) with the URL and the trust
   settings. The agent polls that file every 2 s and replaces its link when it changes;
   `servermin-agent leave` deletes it. `agent.manager.url` in the configuration file takes
   precedence, and `register` refuses to run while one is set. This resolves known issue 16. It
   avoids a local socket: the command already has root, and the agent needs only to read a file in
   its own directory.
4. **Approval.** A registration is `PENDING` until someone with `servers.manage` approves or
   rejects it, or the code approves it at once. There is no polling. The agent connects right away,
   is refused as not enrolled, and retries every 30 s (ADR-002), so it is connected within 30 s of
   approval. A second registration from the same agent supersedes its pending one.
5. **Which server.** A bound code enrols the agent for that server, which keeps its id and name
   (the old key is replaced, and its connection closed). An **unbound code always creates a new
   server**, and never attaches the agent to an existing one, so holding a code is not a way to take
   over a server. The new server takes the agent's own server id when that id is free, so nothing
   changes on the agent; otherwise it gets a fresh id, which the agent adopts from AUTHENTICATED
   (ADR-002). An unbound code for an agent that is already enrolled is refused at approval: use a
   code bound to its server.
6. **Brute force.** A wrong, used, expired or revoked code counts against the address. Ten in 15
   minutes lock the address out of registering for 15 minutes (HTTP 429), even with a valid code.
   A request with malformed fields is refused before the code is looked at and does not use it up.
7. **Audit.** `registration.code.create`, `registration.code.revoke`, `registration.submit` (with
   the reason when refused), `registration.approve` (by a person, or `code:<id>` for a code that
   approves itself) and `registration.reject`.

## Consequences

- Enrolling by hand (`PUT /servers/:id/agent`) still works and is unchanged.
- The Manager guesses the URL in the printed command from the `Host` header the administrator
  used. Behind NAT, agents may need another address. The command is a suggestion, and `--manager`
  can be changed.
- The printed command leaves out the word for running as root, and says `runAs: "root"` instead,
  because the Manager's program is tested to contain no such words.
- `servermin-agent status` without API credentials still cannot list capabilities (known issue 8).
  Registration did not need the local channel that issue called for.
- Registrations are kept: there is no expiry or pruning of old ones yet.
