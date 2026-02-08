# Fixes

## Approve state lost when switching tabs during long-running commands

**Problem:** Clicking Approve on a long-running action (e.g. traceroute) and then switching session tabs made it look like the approval never happened. Switching back showed fresh Approve/Deny buttons instead of "Running...".

**Root cause:** Clicking Approve only updated the DOM button text to "Running..." but never persisted the in-progress state to the action data object. `act.status` stayed `'pending'` throughout the async fetch. When the user switched tabs, `renderChat()` re-rendered from data, saw `pending`, and showed fresh buttons. Additionally, the closure-captured `act` reference could become stale if the `storage` event listener replaced the `sessions` array while the fetch was in-flight.

**Fix:**

1. Added a `'running'` status — `act.status` is set to `'running'` and persisted before the async fetch starts, so any re-render shows a disabled "Running..." button.
2. Added unique IDs to actions — after the async fetch returns, `findLiveAct()` looks up the real action object by ID in the current `sessions` array, rather than relying on the closure reference which may point to a stale object.
3. Updated `restoreAct` to handle the `'running'` status — renders a disabled "Running..." button, preventing duplicate approvals.
4. On error the action reverts to `'pending'` so the user can retry.

**Files changed:** `public/index.html` (`extractAct`, `restoreAct`, `wireAct`)
