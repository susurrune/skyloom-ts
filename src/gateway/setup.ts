/**
 * Channel setup metadata + persistence — the data behind the `sky channels`
 * wizard. Each channel declares the credential fields it needs, where to create
 * the bot (a platform console URL we render as a QR for quick mobile access),
 * and a short how-to. Kept pure/testable; the interactive prompts live in the
 * CLI, and QR rendering is a thin wrapper over qrcode-terminal.
 *
 * Note: Feishu / WeCom / QQ are all official-bot APIs — credentials are created
 * in each platform's developer console, there is no "scan to log in" the way
 * personal WeChat works. So the QR here is a convenience link to the console
 * (scan on your phone → open the console → create the bot → copy the keys), plus
 * a QR of the gateway callback URL to paste back into the console.
 */

export interface ChannelField {
  /** Config key under channels.<id>. */
  key: string;
  /** Human label shown in the wizard. */
  label: string;
  /** Whether the wizard must collect it (some are optional). */
  required: boolean;
  /** Treat as a secret (mask input / store as env-ref suggestion). */
  secret?: boolean;
  /** Env var that also supplies this value. */
  env?: string;
  /** One-line hint on where to find it. */
  hint?: string;
}

export interface ChannelSetupSpec {
  id: string;
  name: string;
  /** Platform console where the bot/app is created (rendered as a QR). */
  consoleUrl: string;
  /** Docs link for the full setup walkthrough. */
  docsUrl?: string;
  /** Webhook path the platform must call back. */
  webhookPath: string;
  /** Ordered credential fields to collect. */
  fields: ChannelField[];
  /** Short, numbered how-to shown before collecting fields. */
  steps: string[];
}

export const CHANNEL_SETUP: Record<string, ChannelSetupSpec> = {
  feishu: {
    id: 'feishu',
    name: '飞书 / Lark',
    consoleUrl: 'https://open.feishu.cn/app',
    docsUrl: 'https://open.feishu.cn/document/home/index',
    webhookPath: '/webhook/feishu',
    fields: [
      { key: 'appId', label: 'App ID', required: true, env: 'FEISHU_APP_ID', hint: '开发者后台 → 凭证与基础信息 → App ID' },
      { key: 'appSecret', label: 'App Secret', required: true, secret: true, env: 'FEISHU_APP_SECRET', hint: '同页 App Secret' },
      { key: 'verificationToken', label: 'Verification Token', required: false, secret: true, env: 'FEISHU_VERIFICATION_TOKEN', hint: '事件订阅 → Verification Token(可选)' },
      { key: 'encryptKey', label: 'Encrypt Key', required: false, secret: true, env: 'FEISHU_ENCRYPT_KEY', hint: '事件订阅 → Encrypt Key(开启加密时填)' },
    ],
    steps: [
      '扫码或打开 https://open.feishu.cn/app 创建「企业自建应用」',
      '在「凭证与基础信息」复制 App ID / App Secret',
      '开启「机器人」能力,在「权限管理」添加 im:message 等权限',
      '「事件订阅」填入下方回调 URL,订阅 im.message.receive_v1',
    ],
  },
  wecom: {
    id: 'wecom',
    name: '企业微信 WeCom',
    consoleUrl: 'https://work.weixin.qq.com/wework_admin/frame',
    docsUrl: 'https://developer.work.weixin.qq.com/document/path/90664',
    webhookPath: '/webhook/wecom',
    fields: [
      { key: 'corpId', label: 'CorpID（企业ID）', required: true, env: 'WECOM_CORP_ID', hint: '管理后台 → 我的企业 → 企业ID' },
      { key: 'corpSecret', label: 'Secret（应用Secret）', required: true, secret: true, env: 'WECOM_CORP_SECRET', hint: '应用管理 → 自建应用 → Secret' },
      { key: 'agentId', label: 'AgentId', required: true, env: 'WECOM_AGENT_ID', hint: '同应用页 AgentId' },
      { key: 'token', label: 'Token', required: true, secret: true, env: 'WECOM_TOKEN', hint: '应用 → 接收消息 → API 接收 → Token' },
      { key: 'encodingAesKey', label: 'EncodingAESKey', required: true, secret: true, env: 'WECOM_AES_KEY', hint: '同页 EncodingAESKey(43 位)' },
    ],
    steps: [
      '扫码或打开企业微信管理后台,进入「应用管理 → 自建 → 创建应用」',
      '复制企业ID、应用 Secret、AgentId',
      '「接收消息」选 API 接收,设置 Token 与 EncodingAESKey',
      '把下方回调 URL 填入「URL」,保存时企业微信会回调验证',
    ],
  },
  qq: {
    id: 'qq',
    name: 'QQ 机器人',
    consoleUrl: 'https://q.qq.com/#/app/bot',
    docsUrl: 'https://bot.q.qq.com/wiki/',
    webhookPath: '/webhook/qq',
    fields: [
      { key: 'appId', label: 'AppID（机器人ID）', required: true, env: 'QQ_BOT_APPID', hint: 'QQ 开放平台 → 机器人 → 开发设置 → AppID' },
      { key: 'secret', label: 'AppSecret', required: true, secret: true, env: 'QQ_BOT_SECRET', hint: '同页 AppSecret' },
    ],
    steps: [
      '扫码或打开 https://q.qq.com 创建机器人,完成开发者认证',
      '在「开发设置」复制 AppID 与 AppSecret',
      '「回调配置」选择 Webhook,填入下方回调 URL',
      '在沙箱里把机器人加为好友 / 拉进群进行测试',
    ],
  },
};

export const SETUP_CHANNEL_IDS = Object.keys(CHANNEL_SETUP);

/** Build the full webhook callback URL for a channel from a public base. */
export function callbackUrl(base: string, channelId: string): string {
  const spec = CHANNEL_SETUP[channelId];
  if (!spec) return '';
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}${spec.webhookPath}`;
}

/**
 * Persist a channel's collected values into ~/.skyloom/config.yaml under
 * channels.<id>, merging with any existing block. Secret-looking values are
 * stored as-is (the file is chmod 0600); callers may instead keep secrets in
 * env and store an { source: env, id } ref. Returns the config path written.
 */
export function saveChannelConfig(
  channelId: string,
  values: Record<string, string>,
  opts?: { configPath?: string },
): string {
  const path = require('path');
  const fs = require('fs');
  const yaml = require('yaml');
  const cfgPath = opts?.configPath || path.join(require('os').homedir(), '.skyloom', 'config.yaml');
  const dir = path.dirname(cfgPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let cfg: any = {};
  if (fs.existsSync(cfgPath)) { try { cfg = yaml.parse(fs.readFileSync(cfgPath, 'utf-8')) || {}; } catch { cfg = {}; } }
  if (!cfg.channels) cfg.channels = {};
  cfg.channels[channelId] = { ...(cfg.channels[channelId] || {}), ...values, enabled: true };
  fs.writeFileSync(cfgPath, yaml.stringify(cfg), { encoding: 'utf-8', mode: 0o600 });
  try { fs.chmodSync(cfgPath, 0o600); } catch { /* best-effort on Windows */ }
  return cfgPath;
}

/** Which required fields are still missing from a values map. */
export function missingRequired(channelId: string, values: Record<string, string>): string[] {
  const spec = CHANNEL_SETUP[channelId];
  if (!spec) return [];
  return spec.fields.filter((f) => f.required && !values[f.key]?.trim()).map((f) => f.key);
}
