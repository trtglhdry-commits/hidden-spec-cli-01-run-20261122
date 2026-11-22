// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does all ten
// sections of SPEC.md: the command line, the output and exit codes, safe paths, format detection, the three-tier
// line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits and the all-or-nothing write.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
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

function parseError(n: number): Exit2 {
  return new Exit2(`error: parse ${n}`);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A line of N: a context line is the file's own matched line (by its index in O); a new line is the patch's text. */
type NItem = { ctx: number } | { text: string };

function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function occurrencesAt(lines: string[], old: string[], tier: number): number[] {
  const key = tier === 0 ? (s: string): string => s : tier === 1 ? trimEndWs : trimWs;
  const pat = old.map(key);
  const out: number[] = [];
  for (let i = 0; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (key(lines[i + j]!) !== pat[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], old: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrencesAt(lines, old, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

function findFrom(lines: string[], old: string[], strict: boolean, from: number): { tier: number; at: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrencesAt(lines, old, tier).filter((i) => i >= from);
    if (occ.length > 0) return { tier, at: occ[0]! };
  }
  return null;
}

function findFromEof(lines: string[], old: string[], strict: boolean, from: number): { tier: number; at: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrencesAt(lines, old, tier).filter((i) => i >= from && i + old.length === lines.length);
    if (occ.length > 0) return { tier, at: occ[0]! };
  }
  return null;
}

function nearest(occ: number[], target: number): number {
  let best = occ[0]!;
  for (const o of occ) {
    if (Math.abs(o - target) < Math.abs(best - target)) best = o;
  }
  return best;
}

/** Resolve a hunk/chunk's N items to lines: context lines are the file's own matched lines; the other lines are
 * the patch's, re-indented at tier 2 (section 5). */
function resolveN(items: NItem[], fileLines: string[], at: number, tier: number, oFirst: string): string[] {
  const F = tier === 2 ? leadWs(fileLines[at] ?? '') : '';
  const P = tier === 2 ? leadWs(oFirst) : '';
  return items.map((it) => {
    if ('ctx' in it) return fileLines[at + it.ctx]!;
    let t = it.text;
    if (tier === 2 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
    return t;
  });
}

/** Re-indent SEARCH/REPLACE new lines at tier 2 (section 5): no context lines there, so every line is re-indented. */
function reindentLines(newLines: string[], fileFirst: string, patchFirst: string): string[] {
  const F = leadWs(fileFirst);
  const P = leadWs(patchFirst);
  return newLines.map((l) => {
    if (l.trim() === '') return l;
    if (!l.startsWith(P)) return l;
    return F + l.slice(P.length);
  });
}

function spliceLines(fileLines: string[], at: number, oldLen: number, newLines: string[]): string[] {
  return [...fileLines.slice(0, at), ...newLines, ...fileLines.slice(at + oldLen)];
}

interface FileState {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function parseFile(text: string): FileState {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], finalBreak: false };
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
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
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

interface Hunk {
  a: number;
  o: string[];
  n: NItem[];
  plus: string[];
  noEolCtxPlus: boolean;
  noEolPlus: boolean;
}

function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

type BodyItem = { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string };

function bodyToON(items: BodyItem[]): { o: string[]; n: NItem[]; plus: string[] } {
  const o: string[] = [];
  const n: NItem[] = [];
  const plus: string[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      const idx = o.length;
      o.push(it.text);
      n.push({ ctx: idx });
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else if (it.kind === 'new') {
      n.push({ text: it.text });
      plus.push(it.text);
    }
  }
  return { o, n, plus };
}

function parseHunk(lines: string[], start: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(lines[start]!);
  if (!m) throw parseError(start + 1);
  const a = Number(m[1]!);
  let i = start + 1;
  const items: BodyItem[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      items.push({ kind: 'ctx', text: '' });
      i++;
    } else if (l.startsWith(' ')) {
      items.push({ kind: 'ctx', text: l.slice(1) });
      i++;
    } else if (l.startsWith('-')) {
      items.push({ kind: 'old', text: l.slice(1) });
      i++;
    } else if (l.startsWith('+')) {
      items.push({ kind: 'new', text: l.slice(1) });
      i++;
    } else if (l.startsWith('\\')) {
      items.push({ kind: 'bs', text: l });
      i++;
    } else {
      break;
    }
  }
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') items.pop();
    else break;
  }
  let lastCtxNew = -1;
  let lastNew = -1;
  for (let k = 0; k < items.length; k++) {
    if (items[k]!.kind === 'ctx' || items[k]!.kind === 'new') lastCtxNew = k;
    if (items[k]!.kind === 'new') lastNew = k;
  }
  const noEolCtxPlus = lastCtxNew >= 0 && lastCtxNew + 1 < items.length && items[lastCtxNew + 1]!.kind === 'bs';
  const noEolPlus = lastNew >= 0 && lastNew + 1 < items.length && items[lastNew + 1]!.kind === 'bs';
  const { o, n, plus } = bodyToON(items);
  return { hunk: { a, o, n, plus, noEolCtxPlus, noEolPlus }, next: i };
}

function applyUnifiedHunk(state: FileState, hunk: Hunk, d: number, strict: boolean): FileState | null {
  if (hunk.o.length === 0) {
    const at = Math.min(hunk.a + d, state.lines.length);
    const newLines = [...state.lines.slice(0, at), ...hunk.plus, ...state.lines.slice(at)];
    const runsToEnd = at === state.lines.length;
    const finalBreak = newLines.length === 0 ? false : runsToEnd ? !hunk.noEolCtxPlus : state.finalBreak;
    return { br: state.br, lines: newLines, finalBreak };
  }
  const found = findTier(state.lines, hunk.o, strict);
  if (found === null) return null;
  const at = nearest(found.occ, hunk.a - 1 + d);
  const n = resolveN(hunk.n, state.lines, at, found.tier, hunk.o[0]!);
  const newLines = spliceLines(state.lines, at, hunk.o.length, n);
  const runsToEnd = at + hunk.o.length === state.lines.length;
  const finalBreak = newLines.length === 0 ? false : runsToEnd ? !hunk.noEolCtxPlus : state.finalBreak;
  return { br: state.br, lines: newLines, finalBreak };
}

/** The text of a created file: the `+` lines of all its hunks, ended by a line break unless a `\` line follows
 * the last `+` line. */
function creationText(hunks: Hunk[]): string {
  const allPlus: string[] = [];
  for (const h of hunks) allPlus.push(...h.plus);
  let noEolPlus = false;
  for (let k = hunks.length - 1; k >= 0; k--) {
    const h = hunks[k]!;
    if (h.plus.length > 0) {
      noEolPlus = h.noEolPlus;
      break;
    }
  }
  return allPlus.length === 0 ? '' : allPlus.join('\n') + (noEolPlus ? '' : '\n');
}

interface UnifiedSection {
  headerOld: string | null;
  headerNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  diffOld: string | null;
  diffNew: string | null;
  hunks: Hunk[];
}

function unifiedEdit(section: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    let oldPath: string | null = null;
    let newPath: string | null = null;
    if (section.headerOld !== null || section.headerNew !== null) {
      oldPath = section.headerOld;
      newPath = section.headerNew;
    } else if (section.renameFrom !== null || section.renameTo !== null) {
      oldPath = section.renameFrom ?? section.renameTo ?? null;
      newPath = section.renameTo ?? section.renameFrom ?? null;
    } else {
      oldPath = section.diffOld;
      newPath = section.diffNew;
    }
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (oldPath === null && newPath === null) return;
    if (oldPath === null) {
      if (tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
      tree.now.set(newPath!, creationText(section.hunks));
      return;
    }
    if (newPath === null) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (section.isCreate) {
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      tree.now.set(newPath, creationText(section.hunks));
      return;
    }
    if (section.isDelete) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    const isMove = oldPath !== newPath;
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    let state = parseFile(before);
    let d = 0;
    for (const h of section.hunks) {
      const res = applyUnifiedHunk(state, h, d, strict);
      if (res === null) throw new Fail('no-match', oldPath);
      d += h.n.length - h.o.length;
      state = res;
    }
    const text = renderFile(state);
    if (isMove) {
      tree.moves.push([oldPath, newPath]);
      tree.now.set(newPath, text);
      tree.now.set(oldPath, null);
    } else {
      tree.now.set(oldPath, text);
    }
  };
}

function parseUnifiedSection(lines: string[], start: number, strict: boolean): { edit: Edit; next: number } {
  let i = start;
  let diffOld: string | null = null;
  let diffNew: string | null = null;
  if (lines[i]!.startsWith('diff --git ')) {
    const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[i]!);
    if (!m) throw parseError(i + 1);
    diffOld = m[1]!;
    diffNew = m[2]!;
    i++;
  }
  let headerOld: string | null = null;
  let headerNew: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let isCreate = false;
  let isDelete = false;
  let sawPair = false;
  const hunks: Hunk[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('@@')) break;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (sawPair) break;
        headerOld = headerPath(line);
        headerNew = headerPath(lines[i + 1]!);
        sawPair = true;
        i += 2;
        continue;
      }
      throw parseError(i + 2);
    }
    if (line.startsWith('+++ ')) {
      i++;
      continue;
    }
    if (line.startsWith('rename from ')) {
      renameFrom = line.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('rename to ')) {
      renameTo = line.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('new file mode')) {
      isCreate = true;
      i++;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      const h = parseHunk(lines, i);
      hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    i++;
  }
  const section: UnifiedSection = { headerOld, headerNew, renameFrom, renameTo, isCreate, isDelete, diffOld, diffNew, hunks };
  return { edit: unifiedEdit(section, strict), next: i };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      const res = parseUnifiedSection(lines, i, strict);
      edits.push(res.edit);
      i = res.next;
    } else if (line.startsWith('@@')) {
      throw parseError(i + 1);
    } else {
      i++;
    }
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const text = newLines.length === 0 ? '' : newLines.join('\n') + '\n';
      tree.now.set(path, text);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = parseFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    let n = newLines;
    if (found.tier === 2) n = reindentLines(newLines, f.lines[at]!, oldLines[0]!);
    const newLinesArr = spliceLines(f.lines, at, oldLines.length, n);
    tree.now.set(path, renderFile({ br: f.br, lines: newLinesArr, finalBreak: f.finalBreak }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevReplace = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw parseError(searchLine + 1);
    }
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw parseError(searchLine + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw parseError(searchLine + 1);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

interface V4aChunk {
  anchor: string;
  body: string[];
  bodyIdx: number[];
  eof: boolean;
}

function parseChunkBody(body: string[], bodyIdx: number[]): { o: string[]; n: NItem[] } {
  const o: string[] = [];
  const n: NItem[] = [];
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l === '') {
      const idx = o.length;
      o.push('');
      n.push({ ctx: idx });
    } else if (l.startsWith(' ')) {
      const idx = o.length;
      o.push(l.slice(1));
      n.push({ ctx: idx });
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1) });
    } else {
      throw parseError(bodyIdx[k]! + 1);
    }
  }
  return { o, n };
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    const text = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
    tree.now.set(path, text);
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFile(before);
    let lines = f.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      const { o, n } = parseChunkBody(chunk.body, chunk.bodyIdx);
      if (chunk.anchor !== '') {
        const found = findFrom(lines, [chunk.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.at + 1;
      }
      if (o.length === 0) {
        const at = chunk.eof ? lines.length : cursor;
        const newLines = n.map((it) => ('text' in it ? it.text : ''));
        lines = spliceLines(lines, at, 0, newLines);
        cursor = at + newLines.length;
      } else {
        const found = chunk.eof ? findFromEof(lines, o, strict, cursor) : findFrom(lines, o, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        const nn = resolveN(n, lines, found.at, found.tier, o[0]!);
        lines = spliceLines(lines, found.at, o.length, nn);
        cursor = found.at + nn.length;
      }
    }
    const text = renderFile({ br: f.br, lines, finalBreak: f.finalBreak });
    if (moveTo !== null) {
      tree.moves.push([path, moveTo]);
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw parseError(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw parseError(first + 1);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw parseError(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const raw: string[] = [];
      const rawIdx: number[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        raw.push(l);
        rawIdx.push(i);
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) {
        raw.pop();
        rawIdx.pop();
      }
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else throw parseError(rawIdx[k]! + 1);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      const raw: string[] = [];
      const rawIdx: number[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        raw.push(l);
        rawIdx.push(i);
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) {
        raw.pop();
        rawIdx.pop();
      }
      for (let k = 0; k < raw.length; k++) {
        if (!blank(raw[k]!)) throw parseError(rawIdx[k]! + 1);
      }
      edits.push(v4aDeleteEdit(path));
    } else if (line.startsWith('*** Update File: ')) {
      const updateLine = i;
      const path = line.slice('*** Update File: '.length).trim();
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const raw: string[] = [];
      const rawIdx: number[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        raw.push(l);
        rawIdx.push(i);
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) {
        raw.pop();
        rawIdx.pop();
      }
      const chunks: V4aChunk[] = [];
      let j = 0;
      let firstChunk = true;
      while (j < raw.length) {
        const l = raw[j]!;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          j++;
          const body: string[] = [];
          const bodyIdx: number[] = [];
          let eof = false;
          while (j < raw.length) {
            const bl = raw[j]!;
            if (bl.startsWith('@@')) break;
            if (bl.trim() === '*** End of File') {
              eof = true;
              j++;
              break;
            }
            body.push(bl);
            bodyIdx.push(rawIdx[j]!);
            j++;
          }
          chunks.push({ anchor, body, bodyIdx, eof });
          firstChunk = false;
        } else if (firstChunk && (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+'))) {
          const body: string[] = [];
          const bodyIdx: number[] = [];
          let eof = false;
          while (j < raw.length) {
            const bl = raw[j]!;
            if (bl.startsWith('@@')) break;
            if (bl.trim() === '*** End of File') {
              eof = true;
              j++;
              break;
            }
            body.push(bl);
            bodyIdx.push(rawIdx[j]!);
            j++;
          }
          chunks.push({ anchor: '', body, bodyIdx, eof });
          firstChunk = false;
        } else {
          throw parseError(rawIdx[j]! + 1);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw parseError(updateLine + 1);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    } else {
      throw parseError(i + 1);
    }
  }
  return edits;
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
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const movePairs: Array<[string, string]> = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      movePairs.push([oldP, newP]);
    }
  }
  const moveOlds = new Set(movePairs.map(([o]) => o));
  const moveNews = new Set(movePairs.map(([, n]) => n));
  const rows: Array<{ key: string; text: string }> = [];
  for (const [oldP, newP] of movePairs) rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
  for (const p of [...tree.now.keys()]) {
    if (moveOlds.has(p) || moveNews.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => {
    const c = Buffer.compare(Buffer.from(a.key), Buffer.from(b.key));
    return c !== 0 ? c : a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
  });
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
