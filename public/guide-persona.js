// Remove the personal-name prefix inserted by earlier versions while keeping style preferences.
export function guidePreferences(value = '') {
  return value.trim().replace(/^(?:你的名字是李云龙。\s*)+/u, '').trim();
}
