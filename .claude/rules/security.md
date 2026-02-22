# Security Rules (301.st)

Security is mandatory. No exceptions.

## Secrets

* Secrets must never be committed to the repository.
* Use `wrangler secret put` for all runtime secrets.
* Do not read or modify local `.env` files.
* Do not log secrets or tokens.

## Encryption

* Credentials must be encrypted using AES-GCM.
* Use Web Crypto API (`crypto.subtle`) only.
* `MASTER_SECRET` is required for credential encryption/decryption.

## Apply Pipeline Safety

* Only the Apply Pipeline may modify customer Cloudflare resources.
* Never bypass Apply Pipeline logic.
* Always verify Cloudflare tokens before applying changes.

## External APIs

* Validate all external input.
* Fail securely on verification errors.
* Never trust external payloads without validation.

If unsure — choose the safer option.

