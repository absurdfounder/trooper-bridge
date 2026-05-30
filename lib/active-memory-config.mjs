function cloneJson(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : {};
}

export function hardenActiveMemoryConfigForBridge(openclawConfig) {
  const next = cloneJson(openclawConfig);
  const entry = next.plugins?.entries?.['active-memory'];
  if (!entry || typeof entry !== 'object') return { config: next, changed: false };
  const before = JSON.stringify(next);
  // Trooper already syncs memories into the runtime workspace and injects
  // compact context itself. The active-memory hook starts a hidden pre-prompt
  // agent run, which makes normal chat look halted and can time out before the
  // actual user request starts. Remove it from the managed gateway config.
  delete next.plugins.entries['active-memory'];
  if (Array.isArray(next.plugins.allow)) {
    next.plugins.allow = next.plugins.allow.filter((id) => id !== 'active-memory');
  }
  return { config: next, changed: JSON.stringify(next) !== before };
}
