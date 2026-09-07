# Recovery ordering evidence

Base: 0f8fdb4a43774b9d21ccfec0ba7d49fa06fec009. Fresh frozen install passed.

Production change: create-daemon recovery terminal replay gate plus TaskRunner durable pending-message query/reconnect filtering. Existing cloud lifecycle/cancellation and journal/outbox formats retained. No dependencies added. Existing compiled fixtures were extended; only plan/contract/research evidence files are new.

Pre-fix compiled regression failed because terminal was confirmed during first-message HTTP503. After repair the same scenario passes, including repeated process death and exact terminal/payload identity. Full client suite1727pass11skip; cloud341pass. Build/typecheck/API/version/workflow pass. Root full test fails on pre-existing cloud-dataplane packaging timeout5000ms; report-only. The first test fixture compile attempt used an unavailable MCP library and was replaced by the SDK's existing authenticated control client; no dependency was added. Two new fixture type omissions were corrected, then typecheck passed.

Remaining workspace tests and a clean exact-source packed Salesko candidate are pending. No registry publication, push, deployment or live daemon changes.
