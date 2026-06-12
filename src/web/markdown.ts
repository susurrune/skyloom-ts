/**
 * 水墨气象台 · Markdown 渲染器 — dependency-free, isomorphic.
 *
 * These functions run in BOTH worlds:
 *  - in Node, imported normally (unit-testable);
 *  - in the browser, injected into the page via `fn.toString()` (see ui.ts).
 *
 * Constraints that follow from the injection trick:
 *  - every function must be a top-level `function` declaration;
 *  - they may only call each other by bare name (no imports, no module-scope
 *    state) — tsc's CommonJS emit keeps such cross-calls as plain identifiers,
 *    so the stringified source stays valid in a browser.
 */

/** HTML-escape text content. */
export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Minimal one-pass syntax highlighter. Tokenizes comments, strings, keywords
 * and numbers with a single alternation so already-emitted HTML is never
 * re-matched. Good-enough coverage for the common languages an agent emits
 * (ts/js/py/sh/go/rust/sql/json); everything unrecognized is just escaped.
 */
export function highlightCode(code: string, lang: string): string {
  if (code.length > 30000) return escapeHtml(code); // don't jank on huge blocks
  const l = (lang || '').toLowerCase();
  const hashComments = /^(py|python|sh|bash|zsh|shell|rb|ruby|yaml|yml|toml|make|makefile|r)$/.test(l);
  const kw = '\\b(?:function|return|if|else|elif|for|while|do|const|let|var|class|import|export|from|async|await|new|try|catch|finally|throw|switch|case|default|break|continue|typeof|instanceof|in|of|def|lambda|pass|yield|with|as|is|not|and|or|None|True|False|self|this|fn|pub|impl|struct|enum|match|use|mod|trait|interface|type|extends|implements|public|private|protected|static|void|null|undefined|true|false|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|JOIN|GROUP|ORDER|BY|LIMIT)\\b';
  const comment = hashComments
    ? '#[^\\n]*'
    : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|--[^\\n]*';
  const re = new RegExp(
    '(' + comment + ')' +
    '|("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)' +
    '|(' + kw + ')' +
    '|(\\b\\d+(?:\\.\\d+)?\\b)',
    'g'
  );
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    out += escapeHtml(code.slice(last, m.index));
    if (m[1]) out += '<span class="tk-c">' + escapeHtml(m[1]) + '</span>';
    else if (m[2]) out += '<span class="tk-s">' + escapeHtml(m[2]) + '</span>';
    else if (m[3]) out += '<span class="tk-k">' + escapeHtml(m[3]) + '</span>';
    else out += '<span class="tk-n">' + escapeHtml(m[4]) + '</span>';
    last = m.index + m[0].length;
  }
  return out + escapeHtml(code.slice(last));
}

/** Inline markdown: code spans, bold, italic, strikethrough, safe links. */
export function mdInline(s: string): string {
  const parts = String(s).split(/(`[^`\n]*`)/);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length > 1 && p.charAt(0) === '`' && p.charAt(p.length - 1) === '`') {
      out += '<code>' + escapeHtml(p.slice(1, -1)) + '</code>';
      continue;
    }
    let t = escapeHtml(p);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    // Only http(s) links; URL was escaped above so quotes can't break out.
    t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    out += t;
  }
  return out;
}

/**
 * Block-level markdown → HTML. Supports: fenced code (with language tag,
 * tolerant of an unclosed fence mid-stream), #–#### headings, hr, blockquote,
 * ul/ol, tables, paragraphs. Unknown constructs degrade to escaped text —
 * never to broken markup.
 */
export function mdToHtml(src: string): string {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let i = 0;
  let para: string[] = [];

  function flushPara() {
    if (para.length) {
      html += '<p>' + para.map(mdInline).join('<br>') + '</p>';
      para = [];
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    // fenced code — tolerate a missing closing fence (streaming)
    const fence = line.match(/^\s*```\s*([\w+#-]*)\s*$/);
    if (fence) {
      flushPara();
      const lang = fence[1] || '';
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // skip closing fence (or run off the end mid-stream)
      const code = buf.join('\n');
      html += '<div class="codeblock"><div class="cb-head"><span class="cb-lang">' +
        escapeHtml(lang || 'text') +
        '</span><button class="cb-copy" type="button">复制</button></div>' +
        '<pre><code>' + highlightCode(code, lang) + '</code></pre></div>';
      continue;
    }

    // blank line → paragraph break
    if (/^\s*$/.test(line)) { flushPara(); i++; continue; }

    // heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      const lvl = h[1].length;
      html += '<h' + (lvl + 1) + ' class="md-h md-h' + lvl + '">' + mdInline(h[2]) + '</h' + (lvl + 1) + '>';
      i++; continue;
    }

    // horizontal rule
    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); html += '<hr>'; i++; continue; }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      html += '<blockquote>' + buf.map(mdInline).join('<br>') + '</blockquote>';
      continue;
    }

    // table: header row | separator row | body rows
    if (line.indexOf('|') >= 0 && i + 1 < lines.length &&
        /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
      flushPara();
      const splitRow = function (r: string): string[] {
        return r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
      };
      const head = splitRow(line);
      i += 2;
      let body = '';
      while (i < lines.length && lines[i].indexOf('|') >= 0 && !/^\s*$/.test(lines[i])) {
        body += '<tr>' + splitRow(lines[i]).map(function (c) { return '<td>' + mdInline(c) + '</td>'; }).join('') + '</tr>';
        i++;
      }
      html += '<div class="md-table"><table><thead><tr>' +
        head.map(function (c) { return '<th>' + mdInline(c) + '</th>'; }).join('') +
        '</tr></thead><tbody>' + body + '</tbody></table></div>';
      continue;
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      let items = '';
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items += '<li>' + mdInline(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>';
        i++;
      }
      html += '<ul>' + items + '</ul>';
      continue;
    }

    // ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushPara();
      let items = '';
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items += '<li>' + mdInline(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>';
        i++;
      }
      html += '<ol>' + items + '</ol>';
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return html;
}
