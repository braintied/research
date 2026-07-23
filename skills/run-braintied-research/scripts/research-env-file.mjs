export function parseDotenvValue(rawValue, filePath, lineNumber) {
  const value = rawValue.trim();
  if (value.length === 0) return '';

  const quote = value[0];
  if (quote === "'" || quote === '"' || quote === '`') {
    let escaped = false;
    let end = -1;
    for (let index = 1; index < value.length; index += 1) {
      const character = value[index];
      if (quote === '"' && character === '\\' && !escaped) {
        escaped = true;
        continue;
      }
      if (character === quote && !escaped) {
        end = index;
        break;
      }
      escaped = false;
    }
    if (end === -1) {
      throw new Error(`Unterminated quoted value in ${filePath}:${lineNumber}.`);
    }
    const trailing = value.slice(end + 1).trim();
    if (trailing.length > 0 && !trailing.startsWith('#')) {
      throw new Error(`Unexpected text after quoted value in ${filePath}:${lineNumber}.`);
    }
    const unquoted = value.slice(1, end);
    if (quote !== '"') return unquoted;
    return unquoted
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r');
  }

  const comment = value.indexOf('#');
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

export function parseAllowlistedEnvFile(contents, filePath, allowedNames) {
  const parsed = new Map();
  const lines = contents.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match === null || !allowedNames.has(match[1])) continue;
    parsed.set(match[1], parseDotenvValue(match[2], filePath, index + 1));
  }
  return parsed;
}
