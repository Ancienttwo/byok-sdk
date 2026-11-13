# Host upgrade to the next MINOR

Draft checklist for a Host moving from 0.42.0 to the next MINOR. Earlier Hosts must first apply the preceding Host upgrade checklists. Release preparation must review this guide against the final train before assigning a version and publishing it.

## Pi cache warming stops at settlement (#1949)

No configuration change is needed. Every SDK Pi RPC session now caps its settings getter at Pi's native `"streaming"` cache-warming mode, preserving `"off"` without rewriting device settings, instead of answering each idle `cache_warming_decision` with `stop`. Pi cancels the warmer at settlement and revalidates pending decisions before dispatch, so a late `"warm"` answer cannot send a refresh after settlement. Under `agentUserContext: 'inherit'` a device setting of `"off"` still turns warming off; under `excluded` the session's settings are in memory and do not read the device file.
