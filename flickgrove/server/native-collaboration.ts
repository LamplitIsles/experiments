// Codex 0.160: model/history can select V2 with false feature flags alone.
// agents.enabled=false resolves Disabled only when the V2 feature is also false.
export const nativeCollaborationConfig = Object.freeze({
  "agents.enabled": false,
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
});
