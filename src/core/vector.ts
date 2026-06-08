/**
 * 向量语义搜索 — TF-IDF + Cosine similarity, zero dependencies.
 *
 * Replaces n-gram Jaccard as the default semantic scorer.
 * - IDF pre-computed from document corpus
 * - Cosine similarity on TF-IDF vectors
 * - CJK-aware tokenization (bigram for CJK, whitespace for ASCII)
 *
 * Usage:
 *   const idx = new VectorIndex();
 *   idx.addDocuments(docs);
 *   const results = idx.search("deploy script", 5);
 */

/* ═══════════════════════════════════════
   Tokenizer — CJK-aware
   ═══════════════════════════════════════ */
const CJK = /[一-鿿぀-ゟ가-힯]/;

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (CJK.test(text[i])) {
      if (i + 1 < text.length && CJK.test(text[i + 1])) {
        tokens.push(text.slice(i, i + 2)); i += 2;
      } else {
        tokens.push(text[i]); i++;
      }
    } else if (/[A-Za-z0-9_]/.test(text[i])) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      tokens.push(text.slice(i, j).toLowerCase()); i = j;
    } else {
      i++;
    }
  }
  return tokens;
}

/* ═══════════════════════════════════════
   TF-IDF Vector computation
   ═══════════════════════════════════════ */
interface DocVector {
  id: string;
  tf: Map<string, number>;
  norm: number;
  content: string;
  meta?: Record<string, any>;
}

export class VectorIndex {
  private docs: DocVector[] = [];
  private idf: Map<string, number> = new Map();
  private totalDocs = 0;

  /** Add a document to the index. */
  addDocument(id: string, content: string, meta?: Record<string, any>): void {
    const tokens = tokenize(content);
    const tf = new Map<string, number>();
    for (const t of tokens) { tf.set(t, (tf.get(t) || 0) + 1); }

    // Normalize by doc length
    const tfIdf = new Map<string, number>();
    let normSq = 0;
    for (const [term, freq] of tf) {
      const tfVal = freq / tokens.length;
      const idfVal = this.idf.get(term) || 0;
      const val = tfVal * Math.max(0.1, idfVal);
      tfIdf.set(term, val);
      normSq += val * val;
    }

    const norm = Math.sqrt(normSq);
    this.docs.push({ id, tf: tfIdf, norm, content: content.slice(0, 500), meta });
    this.totalDocs++;

    // Update IDF
    for (const term of tf.keys()) {
      this.idf.set(term, Math.log((this.totalDocs + 1) / ((this.docFrequency(term) + 1))));
    }
  }

  addDocuments(docs: Array<{ id: string; content: string; meta?: Record<string, any> }>): void {
    for (const d of docs) this.addDocument(d.id, d.content, d.meta);
  }

  private docFrequency(term: string): number {
    let count = 0;
    for (const d of this.docs) { if (d.tf.has(term)) count++; }
    return count;
  }

  /** Search for documents similar to query. Returns [score, doc] pairs. */
  search(query: string, topK: number = 5, minScore: number = 0.01): Array<[number, DocVector]> {
    const queryTokens = tokenize(query);
    const queryTf = new Map<string, number>();
    for (const t of queryTokens) { queryTf.set(t, (queryTf.get(t) || 0) + 1); }

    // Query vector
    const qv = new Map<string, number>();
    let qNormSq = 0;
    for (const [term, freq] of queryTf) {
      const tfVal = freq / queryTokens.length;
      const idfVal = this.idf.get(term) || 0;
      const val = tfVal * Math.max(0.1, idfVal);
      qv.set(term, val);
      qNormSq += val * val;
    }
    const qNorm = Math.sqrt(qNormSq);
    if (qNorm === 0) return [];

    // Cosine similarity against all docs
    const scored: Array<[number, DocVector]> = [];
    for (const doc of this.docs) {
      if (doc.norm === 0) continue;
      let dot = 0;
      for (const [term, qVal] of qv) {
        dot += qVal * (doc.tf.get(term) || 0);
      }
      const score = dot / (qNorm * doc.norm);
      if (score >= minScore) scored.push([score, doc]);
    }

    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, topK);
  }

  /** Remove a document by ID. */
  removeDocument(id: string): void {
    this.docs = this.docs.filter(d => d.id !== id);
    this.totalDocs = this.docs.length;
  }

  get size(): number { return this.docs.length; }

  clear(): void { this.docs = []; this.idf.clear(); this.totalDocs = 0; }
}

/* ═══════════════════════════════════════
   Singleton instance for memory recall
   ═══════════════════════════════════════ */
let globalIndex: VectorIndex | null = null;

export function getVectorIndex(): VectorIndex {
  if (!globalIndex) globalIndex = new VectorIndex();
  return globalIndex;
}

export function resetVectorIndex(): void {
  globalIndex = new VectorIndex();
}
