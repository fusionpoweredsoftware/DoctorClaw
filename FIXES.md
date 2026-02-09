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

## Concurrent approve on multiple actions causes racing LLM streams

**Problem:** When the LLM proposes multiple actions in one response, approving two actions before either completes could cause two concurrent `streamResp()` calls — racing LLM streams, interleaved DOM updates, and corrupted conversation data.

**Root cause:** The approve handler didn't check `streaming` before starting, and didn't guard the `streamResp()` call. Two fetches could return close together, each calling `renderChat()` (destroying the other's streaming DOM) and `streamResp()` simultaneously.

**Fix:**

1. Block approve/deny clicks while `streaming` is true (`if(streaming)return;`), consistent with how `sendMsg()` already works.
2. Guard the `streamResp()` call with `if(!streaming)` so that if streaming somehow became true between the fetch return and the stream call, we still save the data without starting a conflicting stream.
3. Lifted `findLiveAct`, `originId`, and `actId` to the `wireAct` scope so both approve and deny handlers share them, fixing the deny handler's use of stale `cur()`.

**Files changed:** `public/index.html` (`wireAct`)
