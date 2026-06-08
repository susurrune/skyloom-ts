/**
 * 输出过滤模块 — sensitive information sanitization.
 *
 * Before agent responses reach the user (or are persisted),
 * scan for and redact sensitive patterns like API keys,
 * tokens, passwords, PII, and internal paths.
 */

/* ═══════════════════════════════════════
   Detection patterns — compiled once at module load
   ═══════════════════════════════════════ */
const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  // API keys & tokens
  [/sk-[a-zA-Z0-9]{32,}/g, "[REDACTED:API_KEY]"],
  [/(?:api_key|apikey|secret_key|access_token|auth_token)\s*[:=]\s*["']?[^\s"']{8,}["']?/gi, "$1: [REDACTED]"],
  [/ghp_[a-zA-Z0-9]{36}/g, "[REDACTED:GITHUB_TOKEN]"],
  [/gho_[a-zA-Z0-9]{36}/g, "[REDACTED:GITHUB_TOKEN]"],

  // AWS credentials
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED:AWS_KEY]"],
  [/(?:aws_access_key_id|aws_secret_access_key)\s*[:=]\s*["']?[^\s"']+/gi, "$1: [REDACTED]"],

  // Passwords
  [/(?:password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{4,}["']?/gi, "$1: [REDACTED]"],
  [/(?:密码|口令)\s*[:=]\s*["']?[^\s"']{2,}["']?/g, "$1: [已脱敏]"],

  // Connection strings
  [/(?:mongodb|postgres|mysql|redis):\/\/[^\s]+/g, "[REDACTED:DB_URI]"],
  [/(?:jdbc|odbc):[^\s]+/g, "[REDACTED:DB_URI]"],

  // Private keys
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END .*?PRIVATE KEY-----/g, "[REDACTED:PRIVATE_KEY]"],

  // IP addresses (local only)
  [/192\.168\.\d{1,3}\.\d{1,3}/g, "[REDACTED:LAN_IP]"],
  [/10\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, "[REDACTED:LAN_IP]"],
  [/172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}/g, "[REDACTED:LAN_IP]"],

  // File paths
  [/(?:\/etc\/(?:passwd|shadow|hosts|sudoers))/g, "[REDACTED:SYSTEM_PATH]"],
];

/* Email masking (function-based, handled separately) */
const EMAIL_RE = /([a-zA-Z0-9._%+-]{3,})@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;


/* ═══════════════════════════════════════
   Filter function
   ═══════════════════════════════════════ */
export interface FilterResult {
  clean: string;
  redacted: boolean;
  count: number;
  details: string[];
}

export function filterOutput(text: string): FilterResult {
  if (!text) return { clean: "", redacted: false, count: 0, details: [] };

  let clean = text;
  let count = 0;
  const details: string[] = [];

  // Email masking (function-based replacement)
  let emailCount = 0;
  clean = clean.replace(EMAIL_RE, (full, user, domain) => {
    emailCount++;
    return (user as string).slice(0, 2) + "***@" + (domain as string);
  });
  if (emailCount > 0) {
    count += emailCount;
    details.push(`Masked ${emailCount}x email addresses`);
  }

  for (const [pattern, replacement] of SENSITIVE_PATTERNS) {
    const matches = clean.match(pattern);
    if (matches) {
      count += matches.length;
      if (typeof replacement === "string") {
        details.push(`Redacted ${matches.length}x ${pattern.source.slice(0, 30)}`);
      } else {
        details.push(`Masked ${matches.length}x email addresses`);
      }
      clean = clean.replace(pattern, replacement as string);
    }
  }

  return { clean, redacted: count > 0, count, details };
}

/* ═══════════════════════════════════════
   Quick check — is filtering needed?
   ═══════════════════════════════════════ */
export function needsFiltering(text: string): boolean {
  if (!text) return false;
  // Quick scan with the most common patterns
  if (/sk-[a-zA-Z0-9]{32,}/.test(text)) return true;
  if (/api_key.*[:=]/.test(text)) return true;
  if (/password.*[:=]/.test(text)) return true;
  if (/-----BEGIN.*PRIVATE KEY-----/.test(text)) return true;
  if (EMAIL_RE.test(text)) return true;
  return false;
}
