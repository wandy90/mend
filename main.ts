// main.ts is mend, the CLI SPEC.md specifies. Node 22, standard library alone.
// Implements sections 1-10: CLI, output/exits, safe paths, format detection,
// tiered matching, unified diffs, SEARCH/REPLACE, V4A, JSON edits, atomicity.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) { this.line = line; }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) { this.code = code; this.path = path; }
}
const blank = (s: string): boolean => s.trim() === '';
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try { if (statSync(p).isFile()) v = readFileSync(p, 'utf8'); } catch { v = null; }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null { return this.now.has(p) ? this.now.get(p)! : this.original(p); }
}
type Edit = (tree: Tree) => void;
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}
// --- shared file / matching helpers ---
function leadingWS(s: string): string { const m = /^[ \t]*/.exec(s); return m ? m[0] : ''; }
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}
function findTier(O: string[], fileLines: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const o = O.map((l) => normLine(l, tier));
    const pos: number[] = [];
    for (let i = 0; i + o.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) { if (normLine(fileLines[i + j]!, tier) !== o[j]) { ok = false; break; } }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier, positions: pos };
  }
  return null;
}
// N entries with context mapping: nIdx -> oIdx for context lines
function applyON(fileLines: string[], pos: number, O: string[], N: string[], tier: number, ctx: Map<number, number>): string[] {
  const F = fileLines[pos] !== undefined ? leadingWS(fileLines[pos]!) : '';
  const P = O.length > 0 ? leadingWS(O[0]!) : '';
  const out: string[] = [];
  for (let j = 0; j < N.length; j++) {
    if (ctx.has(j)) { out.push(fileLines[pos + ctx.get(j)!]!); continue; }
    const t = N[j]!;
    if (tier !== 2) { out.push(t); continue; }
    if (t === '' || t.trim() === '') { out.push(t); continue; }
    if (!t.startsWith(P)) { out.push(t); continue; }
    out.push(F + t.slice(P.length));
  }
  return [...fileLines.slice(0, pos), ...out, ...fileLines.slice(pos + O.length)];
}
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try { v = JSON.parse(text); } catch { throw new Exit2(`error: parse ${first + 1}`); }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try { e = jsonEdit(JSON.parse(l)); } catch { e = null; }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}
// --- unified ---
interface Hunk { A: number; ops: { kind: 'context' | 'old' | 'new'; text: string; bs: boolean }[]; }
interface UniSection { oldPath: string | null; newPath: string | null; isCreate: boolean; isDelete: boolean; hunks: Hunk[]; }
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}
function headerPath(s: string): string | null {
  // s is text after '--- ' / '+++ ' (4 chars), up to first tab, trimmed
  const t = s.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return stripAB(t);
}
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let i = 0;
  const n = lines.length;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)?$/;
  while (i < n) {
    const line = lines[i]!;
    let sec: UniSection | null = null;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      sec = { oldPath: m[1]!, newPath: m[2]!, isCreate: false, isDelete: false, hunks: [] };
      i++;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
      // header will be parsed below, do not advance yet
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else { i++; continue; }
    // parse header until first hunk or next section start
    let hasPair = false;
    let renameOld: string | null = null;
    let renameNew: string | null = null;
    let diffOld = sec.oldPath;
    let diffNew = sec.newPath;
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('@@')) break;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        if (hasPair) break; // new section
        const oldP = headerPath(l.slice(4));
        const newP = headerPath(lines[i + 1]!.slice(4));
        sec.oldPath = oldP; sec.newPath = newP; hasPair = true;
        i += 2; continue;
      }
      if (l.startsWith('--- ')) {
        // inside header, not followed by +++
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) { renameOld = l.slice('rename from '.length).trim(); i++; continue; }
      if (l.startsWith('rename to ')) { renameNew = l.slice('rename to '.length).trim(); i++; continue; }
      if (l.startsWith('new file mode')) { sec.isCreate = true; i++; continue; }
      if (l.startsWith('deleted file mode')) { sec.isDelete = true; i++; continue; }
      // any other header line ignored
      i++;
    }
    if (!hasPair) {
      if (renameOld !== null) sec.oldPath = renameOld;
      if (renameNew !== null) sec.newPath = renameNew;
      // diff paths already in sec
    }
    // hunks
    while (i < n) {
      const l = lines[i]!;
      if (!l.startsWith('@@')) break;
      const m = hunkRe.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const A = parseInt(m[1]!, 10);
      i++;
      // collect body
      const raw: string[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('@@')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) { raw.push(b); i++; continue; }
        break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const ops: Hunk['ops'] = [];
      for (const b of raw) {
        if (b.startsWith('\\')) {
          if (ops.length > 0) ops[ops.length - 1]!.bs = true;
          continue;
        }
        if (b === '') ops.push({ kind: 'context', text: '', bs: false });
        else if (b.startsWith(' ')) ops.push({ kind: 'context', text: b.slice(1), bs: false });
        else if (b.startsWith('-')) ops.push({ kind: 'old', text: b.slice(1), bs: false });
        else if (b.startsWith('+')) ops.push({ kind: 'new', text: b.slice(1), bs: false });
      }
      sec.hunks.push({ A, ops });
    }
    sections.push(sec);
  }
  const edits: Edit[] = sections.map((sec) => {
    return (tree: Tree) => {
      const oldP = sec.oldPath;
      const newP = sec.newPath;
      // safety before anything else: old then new
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      const isCreate = sec.isCreate || oldP === null;
      const isDelete = sec.isDelete || newP === null;
      if (isCreate && newP === null) throw new Fail('unsafe', '');
      if (isCreate) {
        const np = newP!;
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plusLines: string[] = [];
        let lastBs = false;
        for (const h of sec.hunks) {
          for (const op of h.ops) if (op.kind === 'new') { plusLines.push(op.text); lastBs = op.bs; }
        }
        // last '+' line's bs: if last op overall is new with bs, or if any trailing? use last new op
        const text = plusLines.length === 0 ? '' : plusLines.join('\n') + (!lastBs ? '\n' : '');
        tree.now.set(np, text);
        return;
      }
      if (isDelete) {
        const op = oldP!;
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      // move or change
      const op = oldP!;
      const np = newP!;
      const isMove = op !== np;
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
      const beforeText = tree.get(op)!;
      const { lines: cur0, br, final: final0 } = splitFile(beforeText);
      let cur = [...cur0];
      let final = final0;
      let d = 0;
      for (const h of sec.hunks) {
        const O: string[] = []; const N: string[] = []; const ctx = new Map<number, number>();
        let oIdx = 0; let nIdx = 0;
        for (const o of h.ops) {
          if (o.kind === 'context') { O.push(o.text); N.push(o.text); ctx.set(nIdx, oIdx); oIdx++; nIdx++; }
          else if (o.kind === 'old') { O.push(o.text); oIdx++; }
          else { N.push(o.text); nIdx++; }
        }
        // last context or new op bs
        let lastBs = false;
        for (let k = h.ops.length - 1; k >= 0; k--) {
          const o = h.ops[k]!;
          if (o.kind === 'context' || o.kind === 'new') { lastBs = o.bs; break; }
        }
        if (O.length === 0) {
          const insertPos = Math.min(h.A + d, cur.length);
          const newLines = [...cur.slice(0, insertPos), ...N, ...cur.slice(insertPos)];
          if (insertPos === cur.length) final = !lastBs;
          cur = newLines;
          d += N.length;
        } else {
          const found = findTier(O, cur, strict);
          if (!found) throw new Fail('no-match', op);
          const target = h.A - 1 + d;
          let best = found.positions[0]!; let bestDist = Math.abs(best - target);
          for (const p of found.positions) { const dist = Math.abs(p - target); if (dist < bestDist) { best = p; bestDist = dist; } }
          const runsToEOF = best + O.length === cur.length;
          cur = applyON(cur, best, O, N, found.tier, ctx);
          if (runsToEOF) final = !lastBs;
          d += N.length - O.length;
        }
      }
      const outText = joinFile(cur, br, final);
      if (isMove) {
        tree.now.set(op, null);
        tree.now.set(np, outText);
        tree.moves.push([op, np]);
      } else {
        tree.now.set(op, outText);
      }
    };
  });
  return edits;
}
// --- SEARCH/REPLACE ---
function searchEdits(lines: string[], strict: boolean): Edit[] {
  interface Block { path: string; old: string[]; nw: string[]; searchLine: number; }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const s = i;
    let eq = -1; let end = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    for (let j = eq + 1; j < lines.length; j++) { if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { end = j; break; } }
    if (end < 0) throw new Exit2(`error: parse ${s + 1}`);
    // path: nearest line before s, after prevEnd, not blank, trimmed not starting ```
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim(); break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    blocks.push({ path, old: lines.slice(s + 1, eq), nw: lines.slice(eq + 1, end), searchLine: s + 1 });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return blocks.map((b) => {
    return (tree: Tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.old.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        const text = b.nw.length === 0 ? '' : b.nw.join('\n') + '\n';
        tree.now.set(b.path, text);
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const { lines: cur, br, final } = splitFile(before);
      const found = findTier(b.old, cur, strict);
      if (!found) throw new Fail('no-match', b.path);
      if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
      const pos = found.positions[0]!;
      const ctx = new Map<number, number>();
      const out = applyON(cur, pos, b.old, b.nw, found.tier, ctx);
      tree.now.set(b.path, joinFile(out, br, final));
    };
  });
}
// --- V4A ---
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) { if (!blank(lines[k]!)) { last = k; break; } }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface Chunk { anchor: string | null; eof: boolean; ops: { kind: 'context' | 'old' | 'new'; text: string }[]; }
  interface Section { kind: 'add' | 'delete' | 'update'; path: string; moveTo: string | null; addLines: string[]; chunks: Chunk[]; lineNo: number; }
  const sections: Section[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) { i++; continue; }
    const l = lines[i]!;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (l.startsWith('*** Add File:')) { kind = 'add'; path = l.slice('*** Add File:'.length).trim(); }
    else if (l.startsWith('*** Delete File:')) { kind = 'delete'; path = l.slice('*** Delete File:'.length).trim(); }
    else if (l.startsWith('*** Update File:')) { kind = 'update'; path = l.slice('*** Update File:'.length).trim(); }
    else throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i + 1;
    i++;
    // collect section content lines until next section start or End Patch (last)
    const contentStart = i;
    let contentEnd = last; // exclusive, index of End Patch
    for (let j = i; j < last; j++) {
      const lj = lines[j]!;
      if (lj.startsWith('*** Add File:') || lj.startsWith('*** Delete File:') || lj.startsWith('*** Update File:')) { contentEnd = j; break; }
    }
    const rawContent = lines.slice(contentStart, contentEnd);
    // trim trailing blank lines
    let content = [...rawContent];
    while (content.length > 0 && blank(content[content.length - 1]!)) content.pop();
    i = contentEnd;
    if (kind === 'add') {
      const addLines: string[] = [];
      for (let k = 0; k < content.length; k++) {
        const cl = content[k]!;
        if (cl === '') addLines.push('');
        else if (cl.startsWith('+')) addLines.push(cl.slice(1));
        else throw new Exit2(`error: parse ${contentStart + k + 1}`);
      }
      sections.push({ kind, path, moveTo: null, addLines, chunks: [], lineNo: secLine });
    } else if (kind === 'delete') {
      for (let k = 0; k < content.length; k++) {
        if (!blank(content[k]!)) throw new Exit2(`error: parse ${contentStart + k + 1}`);
      }
      sections.push({ kind, path, moveTo: null, addLines: [], chunks: [], lineNo: secLine });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (content.length > 0 && content[0]!.startsWith('*** Move to:')) { moveTo = content[0]!.slice('*** Move to:'.length).trim(); idx = 1; }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      const pushCur = () => { if (cur && (cur.ops.length > 0 || cur.anchor !== null || cur.eof)) chunks.push(cur); cur = null; };
      for (let k = idx; k < content.length; k++) {
        const cl = content[k]!;
        const lineNo = contentStart + k + 1;
        if (cl.startsWith('@@')) {
          pushCur();
          cur = { anchor: cl.slice(2).trim() === '' ? null : cl.slice(2).trim(), eof: false, ops: [] };
          continue;
        }
        if (cl.trimEnd() === '*** End of File') {
          // Only a marker at column 0 ends the chunk: a context line is
          // ' ' plus the file's line, so a file line that reads
          // '*** End of File' arrives here as ' *** End of File' and
          // must stay a context line, not end the chunk.
          if (cur === null) cur = { anchor: null, eof: false, ops: [] };
          cur.eof = true;
          pushCur();
          continue;
        }
        if (cl.startsWith('*** ')) throw new Exit2(`error: parse ${lineNo}`);
        if (cl === '' || cl.startsWith(' ') || cl.startsWith('-') || cl.startsWith('+')) {
          if (cur === null) cur = { anchor: null, eof: false, ops: [] };
          if (cl === '') cur.ops.push({ kind: 'context', text: '' });
          else if (cl.startsWith(' ')) cur.ops.push({ kind: 'context', text: cl.slice(1) });
          else if (cl.startsWith('-')) cur.ops.push({ kind: 'old', text: cl.slice(1) });
          else cur.ops.push({ kind: 'new', text: cl.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${lineNo}`);
      }
      pushCur();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
      sections.push({ kind, path, moveTo, addLines: [], chunks, lineNo: secLine });
    }
  }
  return sections.map((sec) => {
    return (tree: Tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      if (sec.kind === 'add') {
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        const text = sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n';
        tree.now.set(sec.path, text);
        return;
      }
      if (sec.kind === 'delete') {
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
        return;
      }
      // update
      const before = tree.get(sec.path);
      if (before === null) throw new Fail('missing', sec.path);
      if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      const { lines: cur0, br, final } = splitFile(before);
      let cur = [...cur0];
      let cursor = 0;
      for (const ch of sec.chunks) {
        if (ch.anchor !== null) {
          // first tier where anchor occurs at/after cursor, single line
          let foundIdx = -1;
          const tiers = strict ? [0] : [0, 1, 2];
          outer: for (const tier of tiers) {
            for (let p = cursor; p < cur.length; p++) {
              if (normLine(cur[p]!, tier) === normLine(ch.anchor, tier)) { foundIdx = p; break outer; }
            }
          }
          if (foundIdx < 0) throw new Fail('no-match', sec.path);
          cursor = foundIdx + 1;
        }
        const O: string[] = []; const N: string[] = []; const ctx = new Map<number, number>();
        let oIdx = 0; let nIdx = 0;
        for (const o of ch.ops) {
          if (o.kind === 'context') { O.push(o.text); N.push(o.text); ctx.set(nIdx, oIdx); oIdx++; nIdx++; }
          else if (o.kind === 'old') { O.push(o.text); oIdx++; }
          else { N.push(o.text); nIdx++; }
        }
        if (O.length === 0) {
          const insertPos = ch.eof ? cur.length : cursor;
          cur = [...cur.slice(0, insertPos), ...N, ...cur.slice(insertPos)];
          cursor = insertPos + N.length;
        } else {
          const found = findTier(O, cur, strict);
          if (!found) throw new Fail('no-match', sec.path);
          let pos: number | null = null;
          for (const p of found.positions) {
            if (p < cursor) continue;
            if (ch.eof && p + O.length !== cur.length) continue;
            pos = p; break;
          }
          if (pos === null) throw new Fail('no-match', sec.path);
          cur = applyON(cur, pos, O, N, found.tier, ctx);
          cursor = pos + N.length;
          // Note: applyON returns new array; N.length here is transformed length (same count)
        }
      }
      const outText = joinFile(cur, br, final);
      if (sec.moveTo !== null) {
        tree.now.set(sec.path, null);
        tree.now.set(sec.moveTo, outText);
        tree.moves.push([sec.path, sec.moveTo]);
      } else {
        tree.now.set(sec.path, outText);
      }
    };
  });
}
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try { text = readFileSync(file ?? 0, 'utf8'); } catch { if (file !== null) return { code: 2, out: ['error: no-patch'] }; }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try { edit(tree); } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // output with R handling
  interface Row { key: string; line: string; }
  const rows: Row[] = [];
  const changed = new Set<string>();
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.add(p);
  }
  const usedMoves = new Set<number>();
  tree.moves.forEach(([oldP, newP], idx) => {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null && changed.has(oldP) && changed.has(newP)) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      changed.delete(oldP); changed.delete(newP); usedMoves.add(idx);
    }
  });
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, now); }
  }
  // moves in check mode: no writing, already handled (no files written above for moves? moves are in changed set, removed, so their files would not be written in the loop above!)
  // Handle writing for moves when not check: need write/delete move files explicitly
  if (!check) {
    tree.moves.forEach(([oldP, newP], idx) => {
      // only if this move was used (R emitted, recorded in usedMoves above)
      if (!usedMoves.has(idx)) return;
      const now = tree.get(newP);
      rmSync(oldP, { force: true });
      if (now !== null) { mkdirSync(dirname(newP), { recursive: true }); writeFileSync(newP, now); }
    });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}
const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
