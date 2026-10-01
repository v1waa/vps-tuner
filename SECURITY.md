# Security model

The desktop app has privileged access to each configured VPS. Treat imported shell commands, Docker images and Dockerfiles as executable code.

- Local, sandboxed renderer with context isolation, no Node integration, no remote page embedding.
- Narrow typed IPC, origin and main-frame validation, schema validation in main process.
- Explicit SSH host-key trust on first contact; changed keys fail closed before authentication.
- Passwords and key passphrases are not persisted. Private-key files remain at the user-selected path.
- Scripts are sent over SSH stdin, not embedded into an unquoted remote shell command.
- One operation at a time. Plans are generated in main, one-use, expire after 5 minutes and cannot move across SSH sessions.
- Audit is read-only. Missing permissions and incomplete output do not become a clean security result.
- No blanket deletes, firewall reset, SSH stop, reboot or silent overwrite in built-in recipes.
- UFW initial enable has a 120-second systemd rollback timer. Confirmation requires a different SSH session. The rollback disables UFW rather than restoring every rule.
- Credentials shown/exported explicitly and third-party service logs can be sensitive. Journal stores operation metadata, not raw output or scripts.
- Database and admin ports default to loopback. SSH forwarding binds only to local loopback.
- Xray and WDTT binaries have fixed versions and SHA-256 values. AmneziaWG sources use full commit SHA. Container base images are version-tagged, not digest-pinned; package repositories and image tags can receive upstream updates.

Limitations: installer operations are not transactions; network interruption can leave partial state. Review, back up and audit before retrying. Local admin users, Docker administrators, a compromised remote host, the OS credential/filesystem layer and compromised upstream package sources are outside the protection boundary. CI tests on disposable Ubuntu do not certify operation on every VPS/provider or censorship network.

Please do not put credentials or private keys into public GitHub issues.
