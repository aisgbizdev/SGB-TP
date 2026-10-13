---
name: PWA preview redirects
description: Difference between service-worker requests in the authenticated development preview and local checks.
---

The authenticated development preview can redirect a service-worker script request. Browsers reject redirected worker scripts, even when a direct curl to the same path returns HTTP 200 and a localhost screenshot reports successful registration.

**Why:** This discrepancy occurred during the repository import and was visible in the user's browser logs, but not the local screenshot browser. It is a preview-routing issue, not evidence that the production worker build is invalid.

**How to apply:** Keep development registration disabled unless the preview proxy is confirmed to support worker requests. Preserve production PWA functionality. Do not use curl or the localhost screenshot alone to claim worker registration succeeds in the user's preview.
