# Enterprise Product Audit - 2026-07-07

## Audit Scope

The audit covers the local Web workspace, configuration and session journeys, operational readiness and the path from installation to a successful first task.

## Evidence Limit

The local server was restored and its `/api/status` endpoint returned a healthy six-agent runtime. The in-app browser had no usable tab after the service restart, and its error page could not navigate back to the loopback URL; the Chrome extension was unavailable. No current-run product screenshot could therefore be accepted. Visual findings are intentionally excluded rather than inferred from old captures. Source-level UX findings are grounded in `src/web/ui/index.html`, `src/web/ui/app.ts`, `src/web/ui/styles.css`, `src/web/server.ts` and `tests/web.test.ts`.

## Journey Steps

1. **Launch the local workspace - needs improvement.** Port reuse is handled, but users lack a single diagnostic command covering configuration, credentials, storage and occupied ports.
2. **Choose an agent and session - healthy foundation.** Six agents have distinct identities, per-agent drafts and independent persisted session history.
3. **Configure runtime behavior - improving.** Important settings are available in Web, but operational health and remediation remain split across UI, logs and YAML.
4. **Run and monitor a task - healthy foundation.** Streaming, cancellation and tool events exist; error categories and recovery actions are not yet a shared contract.
5. **Recover or diagnose failure - material gap.** Session restore exists, while failed launches, invalid models, missing credentials and storage problems still require manual investigation.

## Strengths

- A differentiated six-agent product model instead of a generic assistant list.
- Local-first Web binding and host/origin guards.
- Real streaming, stop generation, persisted sessions and per-agent history.
- Shared runtime status already exposes agents, tools, background jobs, MCP and security without secrets.
- The hand-drawn visual language has a clear identity and does not need another wholesale redesign.

## Structural Risks

- Public surfaces do not share stable error codes or recovery metadata.
- Setup validation happens late and differently across CLI, Web and model execution.
- Long-running orchestration is not yet a durable resumable run.
- Tool permissions are still primarily tool-name based instead of resource scoped.
- Operational state is visible to code but not yet presented as a user-facing health center.

## Accessibility Risks

Source inspection shows semantic labels and reduced-motion handling in several areas, but screenshot-only verification was blocked. Keyboard order, focus restoration, contrast, zoom reflow and live-region behavior require a fresh browser run before any compliance claim.

## Recommendation

Build the diagnostic and error contract first, then reuse it in a Web health center. This gives every later reliability feature a stable user-facing language and measurable acceptance criteria.

