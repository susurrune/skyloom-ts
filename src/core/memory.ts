/**
 * Memory system: short-term context, long-term persistence, working memory.
 *
 * Three-layer memory for each agent with SQLite persistence.
 * - Short-term: conversation context (persisted to SQLite)
 * - Working: in-memory task-scoped state
 * - Long-term: persistent key-value storage with search
 */

import initSqlJs, { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import type { MemoryConfig } from './config';
import { getLogger } from './logger';
import { getScorer } from './semantic';

const logger = getLogger('memory');

// Token extraction patterns for fact-recall queries
const ASCII_TOKEN_RE = /[A-Za-z][A-Za-z0-9_+-]+/g;
const CJK_RUN_RE = /[一-鿿]+/g;

/**
 * Message interface representing a conversation message.
 */
export interface Message {
  role: string;
  content: string;
  name?: string | null;
  toolCallId?: string | null;
  toolCalls?: Record<string, any>[] | null;
  reasoningContent?: string | null;
}

/**
 * Simple inline Mutex implementation (replaces async-lock dependency).
 */
class SimpleMutex {
  private _locked = false;
  private _queue: Array<() => void> = [];

  async lock<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      if (!this._locked) {
        this._locked = true;
        resolve();
      } else {
        this._queue.push(resolve);
      }
    });
    try {
      return await fn();
    } finally {
      if (this._queue.length > 0) {
        const next = this._queue.shift()!;
        next();
      } else {
        this._locked = false;
      }
    }
  }
}

/**
 * Three-layer memory system for agents.
 */
export class Memory {
  private config: MemoryConfig;
  private agentName: string;
  public shortTerm: Message[] = [];
  public working: Record<string, any> = {};

  private dbPath: string;
  private db: SqlJsDatabase | null = null;
  private SQL: SqlJsStatic | null = null;
  private loaded = false;
  private pendingPersists: Set<Promise<void>> = new Set();
  private activeSession: string | null = null;

  // short_term is mutated from both main chat loop and handlers
  // All mutations go through a short critical section
  private shortTermLock = new SimpleMutex();

  constructor(config: MemoryConfig, agentName: string) {
    this.config = config;
    this.agentName = agentName;

    const base = expandUserPath(config.dbPath);
    this.dbPath = path.join(path.dirname(base), `${agentName}.db`);
  }

  /**
   * Initialize the database and load persistent data.
   */
  async initDb(): Promise<void> {
    if (this.db !== null) {
      return;
    }

    // Initialize sql.js
    this.SQL = await initSqlJs();

    // Create directory if it doesn't exist
    const dbDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Load existing database or create new
    let dbBuffer: Buffer | null = null;
    if (fs.existsSync(this.dbPath)) {
      try {
        dbBuffer = fs.readFileSync(this.dbPath);
      } catch { /* read failed, start fresh */ }
    }

    this.db = new this.SQL.Database(dbBuffer || undefined);
    this.db.run('PRAGMA journal_mode = MEMORY');
    this.db.run('PRAGMA busy_timeout = 100');

    // Create tables
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migrate existing DBs
    try {
      this.db.run("ALTER TABLE memories ADD COLUMN category TEXT DEFAULT 'general'");
    } catch {
      // Column already exists
    }

    try {
      this.db.run('ALTER TABLE memories ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
    } catch {
      // Column already exists
    }

    // Ensure unique index
    try {
      this.db.run('DROP INDEX IF EXISTS idx_agent_key');
    } catch {
      // Ignore
    }

    this.db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_key ON memories(agent, key)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_agent_category ON memories(agent, category)');

    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        name TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        reasoning_content TEXT,
        session_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.run('CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent, created_at)');

    try {
      this.db.run('ALTER TABLE messages ADD COLUMN tool_calls TEXT');
    } catch {
      // Column already exists
    }

    try {
      this.db.run('ALTER TABLE messages ADD COLUMN reasoning_content TEXT');
    } catch {
      // Column already exists
    }

    try {
      this.db.run('ALTER TABLE messages ADD COLUMN session_id TEXT');
    } catch {
      // Column already exists
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        name TEXT,
        preview TEXT DEFAULT '',
        message_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.run('CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent, updated_at DESC)');

    this.db.run(`
      CREATE TABLE IF NOT EXISTS working_data (
        agent TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (agent, key)
      )
    `);

    this.loadShortTerm();
    this.loadWorking();
  }

  /**
   * Persist the database to disk.
   */
  private persistDb(): void {
    if (!this.db) return;
    try {
      const data = this.db.export();
      fs.writeFileSync(this.dbPath, Buffer.from(data));
    } catch (err) {
      logger.warn('persist_db_failed', { path: this.dbPath, error: String(err) });
    }
  }

  /**
   * Execute a SELECT query and return array of row objects.
   */
  private dbAll(sql: string, params?: any[]): any[] {
    if (!this.db) return [];
    try {
      const stmt = this.db.prepare(sql);
      if (params) stmt.bind(params);
      const rows: any[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      return rows;
    } catch {
      return [];
    }
  }

  /**
   * Execute a SELECT query and return first row object.
   */
  private dbGet(sql: string, params?: any[]): any | null {
    if (!this.db) return null;
    try {
      const stmt = this.db.prepare(sql);
      if (params) stmt.bind(params);
      let row: any = null;
      if (stmt.step()) {
        row = stmt.getAsObject();
      }
      stmt.free();
      return row;
    } catch {
      return null;
    }
  }

  /**
   * Execute a statement and return this for chaining.
   */
  private dbRun(sql: string, params?: any[]): void {
    if (!this.db) return;
    try {
      this.db.run(sql, params);
    } catch (err) {
      logger.warn('db_run_failed', { sql: sql.slice(0, 80), error: String(err) });
    }
  }

  /**
   * Load short-term memory from database.
   */
  private async loadShortTerm(): Promise<void> {
    if (!this.db || this.loaded) {
      return;
    }

    let rows: any[] = [];

    if (this.activeSession) {
      rows = this.dbAll(
        `SELECT role, content, name, tool_call_id, tool_calls, reasoning_content, created_at
         FROM messages
         WHERE agent = ? AND session_id = ?
         ORDER BY id DESC LIMIT ?`,
        [this.agentName, this.activeSession, this.config.shortTermLimit]
      );
    } else {
      this.loaded = true;
      this.pruneDanglingToolCalls();
      return;
    }

    // Truncate at timestamp gap
    const gapSeconds = parseFloat(process.env.WA_RESUME_GAP_SECONDS || '14400'); // 4h default
    rows = Memory.truncateAtTimestampGap(rows, gapSeconds);

    for (const row of rows.reverse()) {
      let toolCalls: Record<string, any>[] | null = null;
      if (row.tool_calls) {
        try {
          toolCalls = JSON.parse(row.tool_calls);
        } catch {
          // Invalid JSON, skip
        }
      }

      this.shortTerm.push({
        role: row.role,
        content: row.content,
        name: row.name,
        toolCallId: row.tool_call_id,
        toolCalls,
        reasoningContent: row.reasoning_content,
      });
    }

    this.loaded = true;
    this.pruneDanglingToolCalls();
  }

  /**
   * Load working memory from database.
   */
  private async loadWorking(): Promise<void> {
    if (!this.db) {
      return;
    }

    const rows = this.dbAll(
      'SELECT key, value FROM working_data WHERE agent = ?',
      [this.agentName]
    );

    for (const row of rows) {
      try {
        this.working[row.key] = JSON.parse(row.value);
      } catch {
        // Skip invalid JSON
      }
    }
  }

  /**
   * Keep only the contiguous tail of rows where consecutive timestamps
   * are within gap_seconds of each other.
   */
  private static truncateAtTimestampGap(rows: any[], gapSeconds: number): any[] {
    if (rows.length === 0 || gapSeconds <= 0) {
      return rows;
    }

    const parseTs = (raw: any): Date | null => {
      if (!raw) return null;
      if (raw instanceof Date) return raw;
      try {
        return new Date(raw);
      } catch {
        return null;
      }
    };

    const keep = [rows[0]];
    let prevTs = parseTs(rows[0].created_at);

    for (let i = 1; i < rows.length; i++) {
      const curTs = parseTs(rows[i].created_at);
      if (prevTs && curTs) {
        const delta = Math.abs((prevTs.getTime() - curTs.getTime()) / 1000);
        if (delta > gapSeconds) {
          break;
        }
      }
      keep.push(rows[i]);
      if (curTs) {
        prevTs = curTs;
      }
    }

    return keep;
  }

  /**
   * Remove orphaned tool_calls/tool message pairs from short-term memory.
   */
  private pruneDanglingToolCalls(): void {
    if (this.shortTerm.length === 0) {
      return;
    }

    const n = this.shortTerm.length;
    const remove = new Array(n).fill(false);

    // Pass 1: position-aware matching
    const waiting: Record<string, number[]> = {};

    for (let i = 0; i < this.shortTerm.length; i++) {
      const msg = this.shortTerm[i];
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          const tid = tc.id;
          if (tid) {
            if (!waiting[tid]) waiting[tid] = [];
            waiting[tid].push(i);
          }
        }
      } else if (msg.role === 'tool' && msg.toolCallId) {
        const tid = msg.toolCallId;
        if (waiting[tid] && waiting[tid].length > 0) {
          waiting[tid].pop();
        } else {
          remove[i] = true;
        }
      }
    }

    // Any assistant indices still in waiting stacks are orphaned
    for (const indices of Object.values(waiting)) {
      for (const i of indices) {
        remove[i] = true;
      }
    }

    if (!remove.some(r => r)) {
      return;
    }

    const kept = this.shortTerm.filter((_, i) => !remove[i]);

    // Pass 2: remove tool messages with no preceding assistant
    const seenTcIds = new Set<string>();
    const sanitized: Message[] = [];

    for (const msg of kept) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          const tid = tc.id;
          if (tid) {
            seenTcIds.add(tid);
          }
        }
      } else if (msg.role === 'tool' && msg.toolCallId && !seenTcIds.has(msg.toolCallId)) {
        continue;
      }
      sanitized.push(msg);
    }

    this.shortTerm = sanitized;
  }

  /**
   * Public wrapper around pruneDanglingToolCalls.
   */
  public pruneToolMessages(): void {
    this.pruneDanglingToolCalls();
  }

  /**
   * Flush pending operations and close database.
   */
  async close(): Promise<void> {
    if (this.db) {
      await this.flushPending();
      this.db.close();
    }
  }

  /**
   * Wait for all pending persist operations to complete.
   */
  private async flushPending(): Promise<void> {
    if (this.pendingPersists.size > 0) {
      const results = await Promise.allSettled(Array.from(this.pendingPersists));
      for (const result of results) {
        if (result.status === 'rejected') {
          logger.warn('flush_persist_failed', { agent: this.agentName, error: String(result.reason) });
        }
      }
      this.pendingPersists.clear();
    }
  }

  // -- Short-term memory --

  /**
   * Add a message to short-term memory.
   */
  public addMessage(role: string, content: string, kwargs?: Record<string, any>): void {
    const msg: Message = {
      role,
      content,
      name: kwargs?.name,
      toolCallId: kwargs?.toolCallId,
      toolCalls: kwargs?.toolCalls,
      reasoningContent: kwargs?.reasoningContent,
    };

    const ephemeral = kwargs?.ephemeral ?? false;

    // Mutex-locked section
    this.shortTermLock.lock(async () => {
      this.shortTerm.push(msg);

      if (this.shortTerm.length > this.config.shortTermLimit) {
        const systemMsgs = this.shortTerm.filter(m => m.role === 'system');
        const otherMsgs = this.shortTerm.filter(m => m.role !== 'system');
        const keep = Math.max(0, this.config.shortTermLimit - systemMsgs.length);
        this.shortTerm = systemMsgs.concat(keep > 0 ? otherMsgs.slice(-keep) : []);
        this.pruneDanglingToolCalls();
      }
    });

    // Persist message if not ephemeral
    if (this.db && role !== 'system' && !ephemeral) {
      const toolCallsJson = msg.toolCalls ? JSON.stringify(msg.toolCalls) : null;
      const sessionId = this.activeSession;

      const promise = this.persistMessage(
        role,
        content,
        msg.name || null,
        msg.toolCallId || null,
        toolCallsJson,
        msg.reasoningContent || null,
        sessionId
      );

      this.pendingPersists.add(promise);
      promise.then(() => {
        this.pendingPersists.delete(promise);
      }).catch(() => {
        this.pendingPersists.delete(promise);
      });
    }
  }

  /**
   * Persist a message to database.
   */
  private async persistMessage(
    role: string,
    content: string,
    name: string | null,
    toolCallId: string | null,
    toolCalls: string | null = null,
    reasoningContent: string | null = null,
    sessionId: string | null = null
  ): Promise<void> {
    if (!this.db) {
      return;
    }

    try {
      this.dbRun(
        `INSERT INTO messages (agent, role, content, name, tool_call_id, tool_calls, reasoning_content, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.agentName, role, content, name, toolCallId, toolCalls, reasoningContent, sessionId]
      );

      if (sessionId) {
        this.dbRun(
          'UPDATE sessions SET message_count = message_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [sessionId]
        );
      }

      // Auto-prune old messages
      const maxPersisted = this.config.maxPersistedMessages || 1000;
      if (sessionId && maxPersisted > 0) {
        const row = this.dbGet(
          'SELECT COUNT(*) as count FROM messages WHERE agent = ? AND session_id = ? AND role != ?',
          [this.agentName, sessionId, 'system']
        );
        if (row && row.count > maxPersisted) {
          const excess = row.count - maxPersisted;
          this.dbRun(
            `DELETE FROM messages WHERE id IN (
              SELECT id FROM messages WHERE agent = ? AND session_id = ? AND role != ?
              ORDER BY id ASC LIMIT ?
            )`,
            [this.agentName, sessionId, 'system', excess]
          );
        }
      }
    } catch (err) {
      logger.warn('persist_message_failed', { agent: this.agentName, error: String(err) });
    }
  }

  /**
   * Get messages as a list of dicts compatible with LLM API.
   */
  public getMessages(): Record<string, any>[] {
    this.pruneDanglingToolCalls();
    const msgs: Record<string, any>[] = [];

    for (const m of this.shortTerm) {
      const d: Record<string, any> = { role: m.role, content: m.content };
      if (m.name) d.name = m.name;
      if (m.toolCallId) d.tool_call_id = m.toolCallId;
      if (m.toolCalls) d.tool_calls = m.toolCalls;
      if (m.reasoningContent) d.reasoning_content = m.reasoningContent;
      msgs.push(d);
    }

    return msgs;
  }

  /**
   * Return stats about current memory usage.
   */
  public getContextWindowUsage(): Record<string, number> {
    let totalChars = 0;
    let cjk = 0;

    for (const m of this.shortTerm) {
      totalChars += m.content.length;
      for (const c of m.content) {
        const code = c.charCodeAt(0);
        if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3000 && code <= 0x303f)) {
          cjk++;
        }
      }
    }

    const other = totalChars - cjk;
    return {
      messageCount: this.shortTerm.length,
      totalChars,
      estimatedTokens: Math.max(1, cjk * 2 + Math.floor(other / 4)),
      limit: this.config.shortTermLimit,
    };
  }

  /**
   * Clear in-memory short-term memory.
   */
  async clearShortTerm(): Promise<void> {
    const systemMsgs = this.shortTerm.filter(m => m.role === 'system');
    this.shortTerm = systemMsgs;

    if (!this.db) {
      return;
    }

    if (this.activeSession !== null) {
      this.dbRun(
        'DELETE FROM messages WHERE agent = ? AND role != ? AND session_id = ?',
        [this.agentName, 'system', this.activeSession]
      );

      this.dbRun(
        'UPDATE sessions SET message_count = 0 WHERE id = ?',
        [this.activeSession]
      );
    } else {
      this.dbRun(
        'DELETE FROM messages WHERE agent = ? AND role != ? AND session_id IS NULL',
        [this.agentName, 'system']
      );
    }
  }

  // -- Working memory --

  /**
   * Set a working memory value.
   */
  public setWorking(key: string, value: any): void {
    this.working[key] = value;
    this.schedulePersistWorking();
  }

  /**
   * Get a working memory value.
   */
  public getWorking(key: string, defaultValue: any = null): any {
    return this.working[key] ?? defaultValue;
  }

  /**
   * Clear all working memory.
   */
  public clearWorking(): void {
    this.working = {};
    this.schedulePersistWorking();
  }

  private schedulePersistWorking(): void {
    if (!this.db) {
      return;
    }

    const promise = this.persistWorking();
    this.pendingPersists.add(promise);
    promise.then(() => {
      this.pendingPersists.delete(promise);
    }).catch(() => {
      this.pendingPersists.delete(promise);
    });
  }

  private async persistWorking(): Promise<void> {
    if (!this.db) {
      return;
    }

    try {
      this.dbRun(
        'DELETE FROM working_data WHERE agent = ?',
        [this.agentName]
      );

      for (const [key, value] of Object.entries(this.working)) {
        this.dbRun(
          'INSERT INTO working_data (agent, key, value) VALUES (?, ?, ?)',
          [this.agentName, key, JSON.stringify(value)]
        );
      }
    } catch (err) {
      logger.warn('persist_working_failed', { agent: this.agentName, error: String(err) });
    }
  }

  // -- Long-term memory --

  /**
   * Store a long-term memory fact.
   */
  async remember(key: string, value: any, category: string = 'general'): Promise<void> {
    if (!this.db) {
      return;
    }

    this.dbRun(
      `INSERT INTO memories (agent, key, value, category) VALUES (?, ?, ?, ?)
       ON CONFLICT(agent, key) DO UPDATE SET value = excluded.value, category = excluded.category, updated_at = CURRENT_TIMESTAMP`,
      [this.agentName, key, JSON.stringify(value), category]
    );
  }

  /**
   * Recall long-term memories.
   */
  async recall(
    key?: string | null,
    category?: string | null,
    limit: number = 20
  ): Promise<Record<string, any>[]> {
    if (!this.db) {
      return [];
    }

    let query = 'SELECT key, value, category FROM memories WHERE agent = ?';
    const params: any[] = [this.agentName];

    if (key) {
      query += ' AND key LIKE ?';
      params.push(`%${key}%`);
    }

    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }

    query += ' ORDER BY updated_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.dbAll(query, params);

    return rows.map((r: any) => ({
      key: r.key,
      value: JSON.parse(r.value),
      category: r.category,
    }));
  }

  /**
   * Forget a memory.
   */
  async forget(key: string): Promise<void> {
    if (!this.db) {
      return;
    }

    this.dbRun(
      'DELETE FROM memories WHERE agent = ? AND key = ?',
      [this.agentName, key]
    );
  }

  /**
   * Tokenize query for recall.
   */
  private static tokenizeForRecall(query: string): string[] {
    const out = new Set<string>();
    const text = query || '';

    // ASCII tokens first
    let match: RegExpExecArray | null;
    while ((match = ASCII_TOKEN_RE.exec(text)) !== null) {
      out.add(match[0]);
    }

    // CJK tokens (n-grams)
    for (const run of text.match(CJK_RUN_RE) || []) {
      for (const size of [3, 2]) {
        if (run.length < size) continue;
        for (let i = 0; i <= run.length - size; i++) {
          out.add(run.slice(i, i + size));
        }
      }
    }

    return Array.from(out);
  }

  /**
   * Recall for injection into prompts.
   */
  async recallForInjection(query: string, limit: number = 3): Promise<Record<string, any>[]> {
    if (!this.db || !query) {
      return [];
    }

    const tokens = Memory.tokenizeForRecall(query).slice(0, 24);
    const likeHits: Record<string, any>[] = [];

    // Pass 1: LIKE token scan
    if (tokens.length > 0) {
      const likeClauses = tokens.map(() => 'key LIKE ? OR value LIKE ?').join(' OR ');
      const params: any[] = [this.agentName];

      for (const tok of tokens) {
        const pattern = `%${tok}%`;
        params.push(pattern, pattern);
      }

      params.push(limit * 2);

      const sql = `SELECT key, value, category, updated_at FROM memories
                   WHERE agent = ? AND (${likeClauses})
                   ORDER BY updated_at DESC LIMIT ?`;

      const rows = this.dbAll(sql, params);

      for (const r of rows) {
        try {
          const val = JSON.parse(r.value);
          likeHits.push({
            key: r.key,
            value: val,
            category: r.category,
            updatedAt: r.updated_at,
          });
        } catch {
          likeHits.push({
            key: r.key,
            value: r.value,
            category: r.category,
            updatedAt: r.updated_at,
          });
        }
      }
    }

    // Pass 2: Semantic scoring (best-effort)
    const semanticHits: Record<string, any>[] = [];
    try {
      const seenKeys = new Set(likeHits.map(h => h.key));
      const rows = this.dbAll(
        'SELECT key, value, category, updated_at FROM memories WHERE agent = ? ORDER BY updated_at DESC LIMIT 200',
        [this.agentName]
      );

      const candidates: Record<string, any>[] = [];
      for (const r of rows) {
        if (seenKeys.has(r.key)) continue;
        try {
          const val = JSON.parse(r.value);
          candidates.push({
            key: r.key,
            value: val,
            category: r.category,
            updatedAt: r.updated_at,
          });
        } catch {
          candidates.push({
            key: r.key,
            value: r.value,
            category: r.category,
            updatedAt: r.updated_at,
          });
        }
      }

      const scorer = getScorer();
      if (scorer) {
        const ranked = scorer.rank(query, candidates, 'value', limit, 0.03);
        for (const [_score, c] of ranked) {
          semanticHits.push(c);
        }
      }
    } catch (err) {
      // Semantic pass is best-effort
      logger.debug('recall_semantic_failed', { error: String(err) });
    }

    // Merge: LIKE first, then semantic
    const seen = new Set<string>();
    const merged: Record<string, any>[] = [];

    for (const src of [likeHits, semanticHits]) {
      for (const item of src) {
        const k = item.key;
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push({ key: k, value: item.value, category: item.category });
        if (merged.length >= limit) {
          return merged;
        }
      }
    }

    return merged;
  }

  /**
   * Format facts as a markdown block for prompt injection.
   */
  static formatFactsBlock(facts: Record<string, any>[]): string {
    if (!facts || facts.length === 0) {
      return '';
    }

    const lines = ['## 相关记忆'];
    for (const f of facts) {
      let v = f.value;
      if (typeof v !== 'string') {
        try {
          v = JSON.stringify(v);
        } catch {
          v = String(v);
        }
      }
      lines.push(`- **${f.key}**: ${v}`);
    }

    return lines.join('\n');
  }

  // -- Session management --

  /**
   * Get active session ID.
   */
  getActiveSession(): string | null {
    return this.activeSession;
  }

  /**
   * Create a new session.
   */
  async createSession(name?: string | null): Promise<string> {
    const sessionId = Math.random().toString(36).slice(2, 14);
    const preview = name || '';

    if (this.db) {
      this.dbRun(
        'INSERT INTO sessions (id, agent, name, preview) VALUES (?, ?, ?, ?)',
        [sessionId, this.agentName, name, preview]
      );
    }

    this.activeSession = sessionId;
    this.shortTerm = this.shortTerm.filter(m => m.role === 'system');
    this.loaded = true;

    return sessionId;
  }

  /**
   * List all sessions.
   */
  async listSessions(): Promise<Record<string, any>[]> {
    if (!this.db) {
      return [];
    }

    const rows = this.dbAll(
      'SELECT id, agent, name, preview, message_count, created_at, updated_at FROM sessions WHERE agent = ? ORDER BY updated_at DESC LIMIT 50',
      [this.agentName]
    );

    return rows.map((r: any) => ({
      id: r.id,
      agent: r.agent,
      name: r.name,
      preview: r.preview,
      messageCount: r.message_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Resume the latest session.
   */
  async resumeLatestSession(): Promise<string | null> {
    if (!this.db || this.activeSession) {
      return this.activeSession;
    }

    const row = this.dbGet(
      'SELECT id FROM sessions WHERE agent = ? ORDER BY updated_at DESC LIMIT 1',
      [this.agentName]
    );

    if (!row) {
      return null;
    }

    this.activeSession = row.id;
    this.loaded = false;
    this.shortTerm = this.shortTerm.filter(m => m.role === 'system');
    await this.loadShortTerm();

    return this.activeSession;
  }

  /**
   * Load a specific session.
   */
  async loadSession(sessionId: string): Promise<boolean> {
    if (!this.db) {
      return false;
    }

    const row = this.dbGet(
      'SELECT id FROM sessions WHERE id = ? AND agent = ?',
      [sessionId, this.agentName]
    );

    if (!row) {
      return false;
    }

    this.activeSession = sessionId;
    this.shortTerm = this.shortTerm.filter(m => m.role === 'system');
    this.loaded = false;
    await this.loadShortTerm();

    return true;
  }

  /**
   * Delete a session.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    if (!this.db) {
      return false;
    }

    const row = this.dbGet(
      'SELECT id FROM sessions WHERE id = ? AND agent = ?',
      [sessionId, this.agentName]
    );

    if (!row) {
      return false;
    }

    this.dbRun(
      'DELETE FROM messages WHERE agent = ? AND session_id = ?',
      [this.agentName, sessionId]
    );

    this.dbRun(
      'DELETE FROM sessions WHERE id = ? AND agent = ?',
      [sessionId, this.agentName]
    );

    if (this.activeSession === sessionId) {
      this.activeSession = null;
      this.shortTerm = this.shortTerm.filter(m => m.role === 'system');
    }

    return true;
  }

  /**
   * Update session preview.
   */
  async updateSessionPreview(): Promise<void> {
    if (!this.db || !this.activeSession) {
      return;
    }

    const row = this.dbGet(
      'SELECT content FROM messages WHERE agent = ? AND session_id = ? AND role = ? ORDER BY id ASC LIMIT 1',
      [this.agentName, this.activeSession, 'user']
    );

    if (row) {
      const preview = row.content.slice(0, 80);
      this.dbRun(
        'UPDATE sessions SET preview = ? WHERE id = ?',
        [preview, this.activeSession]
      );
    }
  }

  /**
   * Get memory statistics.
   */
  async getMemoryStats(): Promise<Record<string, any>> {
    if (!this.db) {
      return { total: 0, categories: {} };
    }

    const rows = this.dbAll(
      'SELECT category, COUNT(*) as count FROM memories WHERE agent = ? GROUP BY category',
      [this.agentName]
    );

    const categories: Record<string, number> = {};
    for (const row of rows) {
      categories[row.category] = row.count;
    }

    return {
      total: Object.values(categories).reduce((a: number, b: number) => a + b, 0),
      categories,
    };
  }
}

/**
 * Helper for expanding home directory paths.
 */
function expandUserPath(filePath: string): string {
  if (filePath.startsWith('~')) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

/**
 * ShortTermLock helper - exposes the lock for use by agent.ts
 */
export function getShortTermLock(memory: Memory): SimpleMutex {
  return (memory as any).shortTermLock;
}
