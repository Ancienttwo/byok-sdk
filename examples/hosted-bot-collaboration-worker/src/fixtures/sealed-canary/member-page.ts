/** Static public markup. No deployment values or secrets belong in this module. */
export const memberPage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sealed canary browser member</title>
<style>
body { max-width: 58rem; margin: 3rem auto; padding: 0 1rem; font: 16px/1.6 system-ui; color: #182126; background: #f6f7f5 }
label { display: block; margin: .7rem 0 } input, textarea { box-sizing: border-box; width: 100%; padding: .6rem; font: inherit }
button { padding: .6rem 1rem; margin: .3rem .3rem .3rem 0 } pre, output { display: block; white-space: pre-wrap; overflow-wrap: anywhere }
fieldset { margin: 1.5rem 0; border: 1px solid #acb7b5 } code { overflow-wrap: anywhere }
</style>
<h1>Sealed canary browser member</h1>
<p>Use this tab on the operator's browser during the staging window. Keys and bearer stay in memory; closing or reloading the tab loses them. The page prints hashes only. Never paste plaintext canaries here.</p>
<fieldset><legend>1. Create this browser member</legend>
<label>Operator bearer <input id="bearer" type="password" autocomplete="off"></label>
<label>Tenant <input id="tenant" autocomplete="off"></label>
<label>Product ID <input id="product" autocomplete="off"></label>
<button id="create">Create keys</button><button id="start" disabled>Start fresh tenant and show pairing input</button>
<output id="pairing"></output>
<p>Give the pairing input to the device privately. It includes a verification secret that must never go to the Host or logs.</p>
<label>This tab's public bundle (safe to copy to another member) <textarea id="bundle" readonly rows="4"></textarea></label>
<button id="copy-bundle" disabled>Copy public bundle</button>
</fieldset>
<fieldset><legend>2. Verify and approve the device</legend>
<p>Copy this tab's public bundle into the device runner's public-bundle stdin command. Compare its local approval-code output with the code below. Approve locally on the device, then confirm here. The page sends add(device) and the client MAC only after this confirmation.</p>
<label>Device ID <input id="device"></label><button id="verify" disabled>Verify device MAC and show code</button>
<output id="device-code"></output>
<label><input id="device-compared" type="checkbox" style="width:auto"> I compared all 50 digits on both screens</label>
<button id="confirm-device" disabled>Confirm device</button>
</fieldset>
<fieldset><legend>Additional browser tabs on the same tenant</legend>
<p>Create keys in the new tab. Copy its public bundle to an active tab; compare the displayed codes in both tabs. Approve in the active tab, then join in the new tab with the active tab's public bundle.</p>
<label>Other browser's public bundle <textarea id="other-bundle" rows="4"></textarea></label>
<button id="compare" disabled>Show browser comparison code</button><output id="browser-code"></output>
<label><input id="browser-compared" type="checkbox" style="width:auto"> I compared all 50 digits on both screens</label>
<button id="approve" disabled>Approve other browser</button><button id="join" disabled>Join using this approver</button>
</fieldset>
<fieldset><legend>3. Distribute scope keys</legend>
<label>Scope ID <input id="scope"></label><label>New epoch (increment after removal) <input id="epoch" type="number" min="1" value="1"></label>
<button id="scope-button" disabled>Issue keys to active members</button>
<p>Issue keys once from an active tab. Use the same task across tabs. Compare the SHA-256 of decrypted <code>document.text</code> with the device's canary hash.</p>
</fieldset>
<fieldset><legend>4. Submit a sealed canary and decrypt C3</legend>
<label>Task routing template JSON (deviceId and payload metadata; omit instruction, sealing and sealed) <textarea id="template" rows="5"></textarea></label>
<button id="submit" disabled>Generate private canary and submit C1</button>
<p>Use the device's approved canary stub, which returns the decrypted instruction in <code>document.text</code>. The page generates and seals the canary without displaying it. Submission fills the task ID and expected hash below. Other tabs copy only those two values.</p>
<label>Task ID <input id="task"></label><label>Expected canary SHA-256 from device <input id="hash" pattern="[0-9a-f]{64}"></label>
<button id="decrypt" disabled>Decrypt and compare</button>
</fieldset>
<fieldset><legend>5. Revoke a browser</legend>
<label>Member ID to remove <input id="remove-member"></label><button id="revoke" disabled>Remove member</button>
<p>From a remaining member, issue a new scope epoch, then submit another sealed task. In the removed tab, enter the new task and hash and decrypt: it must report FAIL with member_revoked and scopeKey: absent for that new epoch. Remaining tabs must report PASS. A failed request or a wrong hash alone is not revocation evidence.</p>
</fieldset>
<pre id="result" role="status">Ready</pre>
<script type="module" src="/member.js"></script>
</html>
`;
