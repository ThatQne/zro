# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Email **thatqne@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce (a proof-of-concept if you have one),
- the zro version (`Settings → About`) and your Windows version.

You'll get an acknowledgement as soon as possible. Please give a reasonable
window to ship a fix before any public disclosure.

## Scope

In scope: the zro desktop app (`src-tauri/`, `src/`) and the auto-update
mechanism. Examples of what we care about:

- Remote code execution or sandbox escape from a visited page into the host.
- Tampering with the signed auto-update flow.
- Exposure of locally-stored secrets (saved passwords, cookies) beyond the
  browser's intended access.

Out of scope: issues in upstream WebView2/Chromium itself (report those to
Microsoft), and social-engineering of the maintainer.

## Handling of user data

zro stores browsing data (history, saved passwords, cookies) **locally only**;
it has no server component and sends no telemetry. The saved-password view is
read-only and gated behind Windows Hello. Private (incognito) sessions are not
recorded to history or memory.
