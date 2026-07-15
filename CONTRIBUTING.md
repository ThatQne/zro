# Contributing to zro

Thanks for wanting to help. Contributions of all kinds are welcome — bug
reports, fixes, features, docs.

## Quick start

```bash
pnpm install
pnpm tauri dev
```

- Rust lives in `src-tauri/`, the UI in `src/`, the landing page in `site/`.
- Keep changes focused; match the surrounding style.
- Before opening a PR: `pnpm build` and `cargo check` (in `src-tauri/`) should pass.

## Licensing of contributions (important)

zro is [dual-licensed](./LICENSE-COMMERCIAL.md): open source under **AGPL-3.0**
and separately under a **commercial license** sold by the maintainer. For the
commercial option to be possible, the maintainer must hold the rights to
relicense every line in the tree — including yours.

**By submitting a contribution (a pull request, patch, or any code/content) you
agree to the following Contributor License Agreement:**

1. You certify that you wrote the contribution, or otherwise have the right to
   submit it, and that you are legally entitled to grant the license below
   (adapted from the [Developer Certificate of Origin](https://developercertificate.org/)).
2. You retain copyright in your contribution.
3. You grant **ThatQne** (the maintainer) a perpetual, worldwide, non-exclusive,
   royalty-free, irrevocable license to use, reproduce, modify, distribute, and
   **sublicense** your contribution, **including the right to license it under
   both the AGPL-3.0 and separate commercial/proprietary terms**.
4. Your contribution is also made available to everyone else under the project's
   current open-source license (AGPL-3.0).

This is what lets zro stay open *and* fund its development. If you are
contributing on behalf of an employer, make sure you have their permission.

> This CLA is intentionally lightweight and is **not legal advice**. If you are a
> company contributing substantial code, ask your legal team to review it first.

## Reporting security issues

Do **not** open a public issue for security vulnerabilities. Email
**thatqne@gmail.com** directly. See [SECURITY.md](./SECURITY.md).
