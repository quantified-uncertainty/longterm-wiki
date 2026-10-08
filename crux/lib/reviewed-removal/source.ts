import fs from 'node:fs';
import path from 'node:path';
import { canonical, type SourceChange } from './model.ts';
import { parseDocument, isMap, isSeq, isScalar, stringify, type Node } from 'yaml';

type RangeEdit = { start: number; end: number; replacement: string };
export function editRanges(before: string, edits: RangeEdit[]): string {
  let after = before, end = before.length;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    if (edit.start < 0 || edit.end > end || edit.end < edit.start) throw new Error('Overlapping or invalid source edits');
    after = after.slice(0, edit.start) + edit.replacement + after.slice(edit.end); end = edit.start;
  }
  return after;
}

/** Replace just the reviewed YAML entries, leaving other entries byte-for-byte intact. */
export function editYaml(before: string, edits: Array<{ selector: string; transform: (value: any) => any | null }>): string {
  const document = parseDocument(before);
  if (document.errors.length) throw new Error('Cannot edit malformed YAML: ' + document.errors[0].message);
  const ranges: RangeEdit[] = [];
  for (const edit of edits) {
    let matches: Node[] = [];
    const [prefix, ...tail] = edit.selector.split('='); const identity = tail.join('=');
    function walk(node: any, depth = 0): void {
      if (isMap(node)) {
        const value: any = node.toJSON();
        const key = prefix === 'footnote' ? String(value.footnote) : prefix === 'targets.slug' ? value.slug : prefix === 'facts.id' || prefix === 'id' ? value.id : value.id ?? value.pageId ?? value.title;
        if (identity && (prefix !== 'id' || depth <= 2) && (key === identity || prefix === 'entry' && key === identity.slice(identity.indexOf(':') + 1))) matches.push(node);
        for (const pair of node.items) if (pair.value) walk(pair.value, depth + 1);
      } else if (isSeq(node)) {
        for (const child of node.items) {
          if (isScalar(child) && prefix === 'entry' && child.value === identity) matches.push(child);
          else if (child) walk(child, depth + 1);
        }
      }
    }
    if (edit.selector.startsWith('overrides.')) {
      const overrides: any = document.get('overrides', true); const key = edit.selector.slice('overrides.'.length);
      const pair = overrides?.items.find((p: any) => p.key.value === key);
      if (!pair) throw new Error('Missing YAML mapping: ' + edit.selector);
      const start = before.lastIndexOf('\n', pair.key.range[0] - 1) + 1;
      ranges.push({ start, end: pair.value.range[2], replacement: '' }); continue;
    }
    walk(document.contents);
    if (matches.length !== 1) throw new Error(`YAML selector matched ${matches.length} entries: ${edit.selector}`);
    const node: any = matches[0], value = node.toJSON(), after = edit.transform(value);
    if (canonical(value) === canonical(after)) throw new Error('Unchanged YAML edit: ' + edit.selector);
    const start = before.lastIndexOf('\n', node.range[0] - 1) + 1;
    if (after == null) { ranges.push({ start, end: node.range[2], replacement: '' }); continue; }
    // Entry maps are sequence items. Serialize only this map at its existing indent.
    const prefixText = before.slice(start, node.range[0]);
    const indent = prefixText.replace(/-\s*$/, '').length;
    const yaml = stringify([after], { lineWidth: 0 }).trimEnd().split('\n').map(line => ' '.repeat(indent) + line).join('\n') + '\n';
    ranges.push({ start, end: node.range[2], replacement: yaml });
  }
  const after = editRanges(before, ranges);
  if (parseDocument(after).errors.length) throw new Error('YAML edits produced invalid syntax');
  return after;
}

function safeFile(root: string, file: string): string {
  const filename = path.resolve(root, file), parent = fs.realpathSync(path.dirname(filename));
  if (!parent.startsWith(fs.realpathSync(root) + path.sep) || fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink()) throw new Error('Source path escapes checkout: ' + file);
  return filename;
}
export function checkFiles(root: string, changes: SourceChange[], rollback = false): void {
  for (const change of changes) {
    const filename = safeFile(root, change.file), expected = rollback ? change.after : change.before;
    const actual = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : null;
    if (actual !== expected) throw new Error('Source changed since review: ' + change.file);
  }
}
export function writeFiles(root: string, changes: SourceChange[], rollback = false): void {
  checkFiles(root, changes, rollback);
  const written: SourceChange[] = [];
  try {
    for (const change of changes) {
      const filename = safeFile(root, change.file), value = rollback ? change.before : change.after;
      if (value == null) fs.unlinkSync(filename);
      else { const temporary = filename + '.removal-tmp'; fs.writeFileSync(temporary, value); fs.renameSync(temporary, filename); }
      written.push(change);
    }
  } catch (error) {
    for (const change of written.reverse()) {
      const value = rollback ? change.after : change.before, filename = safeFile(root, change.file);
      if (value == null) fs.unlinkSync(filename); else fs.writeFileSync(filename, value);
    }
    throw error;
  }
}
