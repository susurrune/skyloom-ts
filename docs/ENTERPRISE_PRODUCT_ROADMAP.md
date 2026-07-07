# Skyloom Enterprise Product Roadmap

> Product direction: turn Skyloom from a feature-rich multi-agent client into a local-first, auditable and recoverable AI workspace that teams can trust for daily production work.

## Product Promise

Skyloom should give an individual or team three guarantees:

1. **The work is controllable.** Users can see which agent, model, session and tools are active before side effects happen.
2. **The work is recoverable.** Interrupted conversations, failed workflow steps and provider outages do not destroy completed work.
3. **The work is explainable.** Every material result has a traceable run, evidence, cost, error category and next action.

The six weather agents remain the recognizable product model. Enterprise capability should strengthen that identity instead of replacing it with a generic administration console.

## Product Principles

- Local-first by default; remote access is explicit and protected.
- One contract across CLI, TUI, Web, gateways and automation.
- Errors must be actionable: what failed, whether retry is safe, and what the user can do next.
- Progressive disclosure: a calm default experience with deep operational detail available on demand.
- No silent data loss, silent fallback or silent permission expansion.
- Stable, scriptable interfaces are product features, not implementation details.

## Success Metrics

| Outcome | Primary metric | Target |
| --- | --- | --- |
| Fast activation | First successful response after install | >= 85% without manual file editing |
| Reliable work | Successful or safely recoverable turns | >= 99% |
| Clear failures | Errors with stable code and next action | 100% of public entry points |
| Durable sessions | Restorable interrupted sessions | >= 99.9% |
| Efficient execution | Median time to first streamed token | < 1.5 s excluding provider latency |
| Safe autonomy | Side effects covered by an explicit scope | 100% |
| Operability | Environment issues diagnosed by `sky doctor --json` | >= 90% of setup incidents |

## Delivery Stages

### P0 - Trustworthy Daily Driver

- [ ] Add a shared structured error taxonomy: auth, rate limit, timeout, context overflow, invalid configuration, permission denied, provider failure and cancellation.
- [x] Add a shared runtime status snapshot for Web and diagnostics.
- [x] Add `sky doctor --json` for runtime, configuration, model, credential, workspace, memory, MCP and port checks.
- [ ] Refuse non-loopback Web exposure unless an explicit authentication policy is configured.
- [ ] Make every tool side effect cancellable and resource-scoped.
- [ ] Persist orchestration runs and resume only failed nodes and their downstream dependencies.
- [ ] Make session writes awaitable, corruption-aware and recoverable.

Exit criteria: a failed launch or turn yields a stable diagnosis; interrupted work can be resumed; no supported side effect escapes cancellation or policy.

### P1 - Professional Workspace

- [ ] Add a Web health center backed by the doctor and runtime contracts.
- [ ] Add named workspaces, session search, pin/archive, run timeline and evidence export.
- [ ] Expose model capability, cost and privacy information before execution.
- [ ] Add reusable workflow templates with typed inputs, approval checkpoints and result artifacts.
- [ ] Add an operations guide and a sanitized support bundle.
- [ ] Publish and test a supported npm root entrypoint for programmatic integrations.

Exit criteria: a professional user can configure, monitor, diagnose and export work without editing YAML or reading logs.

### P2 - Team Governance

- [ ] Add workspace policy profiles for models, tools, paths, networks and budget limits.
- [ ] Add append-only audit events with actor, agent, session, trace and resource identifiers.
- [ ] Add secret-provider interfaces so plaintext keys are optional.
- [ ] Add gateway idempotency, durable delivery queues and replay controls.
- [ ] Add extension signing/trust metadata and complete activate/health/deactivate lifecycle.

Exit criteria: administrators can prove what ran, constrain what may run, rotate credentials and recover external deliveries.

### P3 - Platform Excellence

- [ ] Publish versioned automation and Web API contracts.
- [ ] Add evaluation suites for routing quality, task completion, tool selection and regression detection.
- [ ] Add organization-ready deployment patterns, SSO adapter boundaries and policy-as-code imports.
- [ ] Add an extension compatibility matrix and release channels.

Exit criteria: Skyloom can be upgraded, integrated and governed without relying on undocumented behavior.

## Experience Priorities

1. **Start:** one command opens the correct workspace or explains exactly why it cannot.
2. **Orient:** agent, model, session, permission mode and health are visible without visual noise.
3. **Work:** streaming, tool activity, cancellation and retry are predictable.
4. **Recover:** history, checkpoints and failed steps are first-class, not hidden implementation state.
5. **Trust:** costs, evidence, permissions and errors are inspectable at the moment they matter.

## Architecture Workstreams

| Workstream | Near-term deliverable | Enterprise outcome |
| --- | --- | --- |
| Runtime contracts | Doctor report and structured errors | Operable and automatable deployments |
| Agent lifecycle | Finish `BaseAgent` decomposition | Smaller blast radius and safer evolution |
| Model layer | Capability-aware resolved models | Fewer invalid requests and honest fallbacks |
| Sessions and memory | Repository boundaries and durable writes | Reliable, auditable conversation state |
| Orchestration | Serializable runs and selective retry | Recoverable long-running work |
| Tool security | Resource scopes and cancellation | Governable autonomy |
| Web product | Health center and run timeline | Self-service professional experience |
| Gateways and extensions | Idempotency and lifecycle health | Production-grade integrations |

## Current Increment

The first increment is `sky doctor --json`. It establishes a sanitized, machine-readable diagnostic contract before the same information is surfaced in Web. The implementation must not contact model providers, reveal credentials or mutate user configuration.
