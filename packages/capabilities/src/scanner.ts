export type Severity = "block" | "warn";

export interface Finding {
  rule: string;
  severity: Severity;
  excerpt: string;
}

export interface ScanResult {
  blocked: boolean;
  findings: Finding[];
}

interface Rule {
  id: string;
  severity: Severity;
  pattern: RegExp;
}

const RULES: Rule[] = [
  { id: "override-instructions", severity: "block", pattern: /\b(ignore|disregard|forget)\b[^.\n]{0,30}\b(previous|prior|above|earlier|system)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?|guidelines?)\b/i },
  { id: "override-instructions-ru", severity: "block", pattern: /(игнорир|забуд|отброс)[а-яё]*\s+[^.\n]{0,30}(предыдущ|прежн|систем|все|любые)[а-яё]*\s+(инструкци|правил|указани|промпт)/i },
  { id: "hide-from-user", severity: "block", pattern: /\b(do not|don't|never)\s+(tell|inform|show|mention|reveal)\b[^.\n]{0,40}\b(user|human|owner)\b/i },
  { id: "hide-from-user-ru", severity: "block", pattern: /не\s+(говори|сообщай|показывай|упоминай)[^.\n]{0,40}пользовател/i },
  { id: "exfiltrate-secrets", severity: "block", pattern: /\b(send|upload|post|forward|exfiltrate|transmit)\b[^.\n]{0,60}\b(api[_ -]?keys?|tokens?|passwords?|credentials?|secrets?|private key|\.env|ssh)\b/i },
  { id: "pipe-to-shell", severity: "block", pattern: /\b(curl|wget)\b[^\n]{0,200}\|\s*(sudo\s+)?(ba|z)?sh\b/i },
  { id: "fake-role-tags", severity: "block", pattern: /<\s*\/?\s*(system|assistant|developer)\s*>/i },
  { id: "hidden-characters", severity: "block", pattern: /[​-‏‪-‮⁠-⁤﻿]/ },
  { id: "credential-paths", severity: "warn", pattern: /~\/\.(ssh|aws|gnupg)|\/etc\/(passwd|shadow)|\.env\b/i },
  { id: "long-base64", severity: "warn", pattern: /[A-Za-z0-9+/]{200,}={0,2}/ },
  { id: "role-reassignment", severity: "warn", pattern: /\byou are now\b|\bnew instructions?:/i },
];

/**
 * Cheap static scan of tool descriptions and skill text. It catches the crude
 * and the common; it is one layer next to the sandbox and effect policy, not a
 * guarantee.
 */
export function scanText(text: string): ScanResult {
  const findings: Finding[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match) {
      findings.push({ rule: rule.id, severity: rule.severity, excerpt: excerpt(text, match.index, match[0].length) });
    }
  }
  return { blocked: findings.some((f) => f.severity === "block"), findings };
}

function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 20);
  const end = Math.min(text.length, index + length + 20);
  return text.slice(start, end).replace(/[​-‏‪-‮⁠-⁤﻿]/g, "�").replace(/\s+/g, " ");
}
