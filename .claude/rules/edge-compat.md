# Edge compatibility (Cloudflare Workers)

All code must be Edge-compatible.

## Forbidden

* Node.js APIs: fs, path, process, child_process
* Node `crypto` module

## Allowed

* Web Crypto API (`crypto.subtle`)
* Edge-compatible libraries only

If unsure — assume not compatible.

