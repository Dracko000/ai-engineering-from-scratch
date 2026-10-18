'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Anchor = require('./highlights-anchor');
const StoreModule = require('./highlights-store');
const { parseMd } = require('./lesson-markdown');

class TextNode {
  constructor(value) { this.nodeType = 3; this.nodeValue = value; this.parentNode = null; }
  get textContent() { return this.nodeValue; }
  splitText(offset) {
    const rest = new TextNode(this.nodeValue.slice(offset));
    this.nodeValue = this.nodeValue.slice(0, offset);
    const parent = this.parentNode;
    const at = parent.childNodes.indexOf(this);
    parent.childNodes.splice(at + 1, 0, rest);
    rest.parentNode = parent;
    return rest;
  }
}

class ElementNode {
  constructor(tag, attrs = {}) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attributes = { ...attrs };
    this.childNodes = [];
    this.parentNode = null;
  }
  get id() { return this.attributes.id || ''; }
  set id(value) { this.attributes.id = value; }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, before) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
  normalize() {
    const merged = [];
    for (const child of this.childNodes) {
      const last = merged[merged.length - 1];
      if (child.nodeType === 3 && last && last.nodeType === 3) last.nodeValue += child.nodeValue;
      else if (child.nodeType !== 3 || child.nodeValue) merged.push(child);
    }
    this.childNodes = merged;
  }
  querySelector(selector) {
    if (selector !== 'annotation[encoding="application/x-tex"]') throw new Error('unsupported selector ' + selector);
    const stack = [...this.childNodes];
    while (stack.length) {
      const node = stack.shift();
      if (node.nodeType !== 1) continue;
      if (node.tagName === 'ANNOTATION' && node.getAttribute('encoding') === 'application/x-tex') return node;
      stack.unshift(...node.childNodes);
    }
    return null;
  }
  findAll(predicate, out = []) {
    for (const child of this.childNodes) {
      if (child.nodeType === 1) {
        if (predicate(child)) out.push(child);
        child.findAll(predicate, out);
      }
    }
    return out;
  }
}

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

function decode(text) {
  return text.replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (match, code) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[code.toLowerCase()];
    if (named) return named;
    return String.fromCodePoint(code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10));
  });
}

function parseHtml(html) {
  const root = new ElementNode('article', { class: 'lesson-article' });
  const stack = [root];
  const pattern = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^\s=>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  let match;
  while ((match = pattern.exec(html))) {
    const top = stack[stack.length - 1];
    if (match[0].startsWith('<!--')) continue;
    if (match[1]) {
      const tag = match[1].toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag) { stack.length = i; break; }
      }
      continue;
    }
    if (match[2]) {
      const attrs = {};
      const attrPattern = /([^\s=>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let attr;
      while ((attr = attrPattern.exec(match[3] || ''))) attrs[attr[1]] = decode(attr[2] ?? attr[3] ?? attr[4] ?? '');
      const element = new ElementNode(match[2], attrs);
      top.appendChild(element);
      if (!match[4] && !VOID.has(match[2].toLowerCase())) stack.push(element);
      continue;
    }
    top.appendChild(new TextNode(decode(match[5])));
  }
  return root;
}

function lessonDom(md) {
  return parseHtml(parseMd(md));
}

function modelOf(md) {
  return Anchor.buildModel(lessonDom(md));
}

function select(text, exact, occurrence = 0) {
  let at = -1;
  for (let i = 0; i <= occurrence; i++) at = text.indexOf(exact, at + 1);
  assert.ok(at >= 0, `"${exact}" is in the text`);
  return Anchor.describe(text, at, at + exact.length);
}

const LESSON = [
  '# Gradient Descent',
  '',
  '## The Problem',
  '',
  'A model has parameters. Training moves the parameters so that the loss gets smaller on every step.',
  '',
  'The gradient points in the direction of steepest increase, so we step the other way.',
  '',
  '## Build It',
  '',
  'Start with one parameter and a learning rate that is small enough to stay stable.',
  '',
  '```python',
  'def step(w, grad, lr):',
  '    return w - lr * grad',
  '```',
  '',
  'The update rule is $w \\leftarrow w - \\eta \\nabla L$ for every parameter.',
  '',
  '## Summary',
  '',
  'Small steps converge. Large steps can overshoot and diverge.',
].join('\n');

test('normalization collapses whitespace and maps back to raw offsets', () => {
  const normalized = Anchor.normalize('  one \n\t two\u00a0three\u200b four  ');
  assert.equal(normalized.text, 'one two three four');
  const span = Anchor.rawToNormalized(normalized, 2, 13);
  assert.equal(normalized.text.slice(span.start, span.end), 'one two');
  const raw = Anchor.normalizedToRaw(normalized, span.start, span.end);
  assert.equal('  one \n\t two\u00a0three'.slice(raw.start, raw.end), 'one \n\t two');
});

test('an unchanged lesson re-anchors by quote and context', () => {
  const model = modelOf(LESSON);
  const selector = select(model.text, 'steepest increase');
  const hit = Anchor.locate(model.text, selector);
  assert.equal(hit.method, 'context');
  assert.equal(model.text.slice(hit.start, hit.end), 'steepest increase');
});

test('text inserted before the quote moves the anchor but keeps the context match', () => {
  const before = modelOf(LESSON);
  const selector = select(before.text, 'the loss gets smaller');
  const edited = LESSON.replace('## The Problem\n\n', '## The Problem\n\nThis paragraph is new and pushes everything down the page by a lot of characters.\n\n');
  const after = modelOf(edited);
  const hit = Anchor.locate(after.text, selector);
  assert.equal(hit.method, 'context');
  assert.ok(hit.start > selector.position.start);
  assert.equal(after.text.slice(hit.start, hit.end), 'the loss gets smaller');
});

test('text inserted after the quote keeps the anchor in place', () => {
  const before = modelOf(LESSON);
  const selector = select(before.text, 'one parameter and a learning rate');
  const edited = LESSON.replace('Small steps converge.', 'Small steps converge, slowly but surely.');
  const after = modelOf(edited);
  const hit = Anchor.locate(after.text, selector);
  assert.equal(hit.method, 'context');
  assert.equal(hit.start, selector.position.start);
});

test('text inserted inside the quote falls back to a bounded fuzzy match', () => {
  const before = modelOf(LESSON);
  const selector = select(before.text, 'Training moves the parameters so that the loss gets smaller');
  const edited = LESSON.replace('Training moves the parameters', 'Training slowly moves the parameters');
  const after = modelOf(edited);
  const hit = Anchor.locate(after.text, selector);
  assert.equal(hit.method, 'fuzzy');
  assert.ok(hit.score >= Anchor.FUZZY_THRESHOLD);
  assert.equal(after.text.slice(hit.start, hit.end), 'Training slowly moves the parameters so that the loss gets smaller');
});

test('a context edit around the quote still finds the exact quote alone', () => {
  const before = modelOf(LESSON);
  const selector = select(before.text, 'steepest increase');
  const edited = LESSON.replace('The gradient points in the direction of steepest increase, so we step the other way.', 'Gradients aim toward steepest increase; we walk downhill instead.');
  const after = modelOf(edited);
  const hit = Anchor.locate(after.text, selector);
  assert.equal(hit.method, 'quote');
  assert.equal(after.text.slice(hit.start, hit.end), 'steepest increase');
});

test('deleted text orphans the highlight instead of matching something else', () => {
  const before = modelOf(LESSON);
  const selector = select(before.text, 'Large steps can overshoot and diverge.');
  const edited = LESSON.replace(' Large steps can overshoot and diverge.', '');
  const after = modelOf(edited);
  assert.equal(Anchor.locate(after.text, selector), null);
});

test('a partly deleted quote still re-anchors when most of it survives', () => {
  const before = modelOf(LESSON);
  const selector = select(before.text, 'a learning rate that is small enough to stay stable');
  const edited = LESSON.replace('small enough to stay stable', 'small enough to stay');
  const after = modelOf(edited);
  const hit = Anchor.locate(after.text, selector);
  assert.equal(hit.method, 'fuzzy');
  assert.match(after.text.slice(hit.start, hit.end), /^a learning rate that is small enough to stay/);
});

test('short quotes never fuzzy match, so a changed short quote is orphaned', () => {
  const before = modelOf(LESSON);
  const selector = select(before.text, 'stable');
  const after = modelOf(LESSON.replace('stay stable', 'stay calm'));
  assert.equal(Anchor.locate(after.text, selector), null);
});

test('duplicate quotes resolve to the right copy by context, then by position', () => {
  const md = [
    '## One', '', 'Always check the shapes before you multiply.', '',
    '## Two', '', 'In the second pass, always check the shapes before you multiply.', '',
    '## Three', '', 'At the end, always check the shapes before you multiply.',
  ].join('\n');
  const before = modelOf(md);
  const selector = select(before.text, 'check the shapes before you multiply', 1);
  const hit = Anchor.locate(before.text, selector);
  assert.equal(hit.method, 'context');
  assert.equal(hit.start, selector.position.start);

  const edited = md.replace('In the second pass, always', 'Next, you should always').replace('multiply.\n\n## Three', 'multiply them.\n\n## Three');
  const after = modelOf(edited);
  const moved = Anchor.locate(after.text, selector);
  assert.equal(moved.method, 'quote');
  const second = after.text.indexOf('check the shapes', after.text.indexOf('Next, you should'));
  assert.equal(moved.start, second);
});

test('whitespace and line wrapping changes are invisible to the anchor', () => {
  const before = modelOf(LESSON);
  const selector = select(before.text, 'direction of steepest increase, so we step');
  const edited = LESSON.replace('The gradient points in the direction of steepest increase, so we step the other way.', 'The gradient points in the direction\nof   steepest increase,\nso we step the other way.');
  const after = modelOf(edited);
  const hit = Anchor.locate(after.text, selector);
  assert.equal(hit.method, 'context');
});

test('markdown emphasis and link changes keep the rendered text anchored', () => {
  const before = modelOf(LESSON);
  const selector = select(before.text, 'The gradient points in the direction of steepest increase');
  const edited = LESSON.replace('The gradient points in the direction of steepest increase', '**The gradient** points in the [direction](https://example.com) of `steepest` increase');
  const after = modelOf(edited);
  const hit = Anchor.locate(after.text, selector);
  assert.equal(hit.method, 'context');
  assert.equal(after.text.slice(hit.start, hit.end), 'The gradient points in the direction of steepest increase');
});

test('code blocks anchor on code text and skip the copy button and language label', () => {
  const model = modelOf(LESSON);
  assert.doesNotMatch(model.text, /Copy def/);
  assert.doesNotMatch(model.text, /python def/);
  const selector = select(model.text, 'return w - lr * grad');
  const edited = LESSON.replace('def step(w, grad, lr):', 'def step(w, grad, lr=0.1):');
  const after = modelOf(edited);
  const hit = Anchor.locate(after.text, selector);
  assert.equal(after.text.slice(hit.start, hit.end), 'return w - lr * grad');
});

test('math is one atomic span whose text is the same before and after KaTeX renders', () => {
  const plain = lessonDom(LESSON);
  const rendered = lessonDom(LESSON);
  for (const math of rendered.findAll(node => (node.getAttribute('class') || '').includes('math-inline'))) {
    const tex = math.textContent;
    math.childNodes = [];
    const katex = new ElementNode('span', { class: 'katex' });
    const mathml = new ElementNode('span', { class: 'katex-mathml' });
    const annotation = new ElementNode('annotation', { encoding: 'application/x-tex' });
    annotation.appendChild(new TextNode(tex));
    mathml.appendChild(annotation);
    const visual = new ElementNode('span', { class: 'katex-html', 'aria-hidden': 'true' });
    visual.appendChild(new TextNode('w \u2190 w \u2212 \u03b7 \u2207 L'));
    katex.appendChild(mathml);
    katex.appendChild(visual);
    math.appendChild(katex);
  }
  const before = Anchor.buildModel(plain);
  const after = Anchor.buildModel(rendered);
  assert.equal(after.text, before.text);
  const selector = select(before.text, 'The update rule is w \\leftarrow w - \\eta \\nabla L for every');
  const hit = Anchor.locate(after.text, selector);
  assert.equal(hit.method, 'context');
  const painted = Anchor.wrap(after, hit.start, hit.end, () => new ElementNode('mark', { class: 'aifs-hl' }));
  assert.equal(painted.atoms.length, 1);
  assert.ok(painted.marks.length >= 2);
  for (const mark of painted.marks) assert.equal(mark.parentNode.getAttribute('class'), null);
  assert.equal(painted.atoms[0].findAll(node => node.tagName === 'MARK').length, 0);
});

test('long quotes re-anchor through head and tail matches after an inner edit', () => {
  const md = '## Loop\n\nIntro sentence before the loop.\n\nEach training step reads a batch of examples from the loader, computes the loss for that batch, takes the gradient of the loss with respect to every parameter, and moves each parameter a small amount against its gradient. Repeat this until the validation loss stops falling for several epochs in a row, then keep the best checkpoint.\n\nClosing sentence after the loop.';
  const before = modelOf(md);
  const start = before.text.indexOf('Each training');
  const end = before.text.indexOf('best checkpoint.') + 'best checkpoint.'.length;
  assert.ok(end - start > 256);
  const selector = Anchor.describe(before.text, start, end);
  const edited = md.replace('computes the loss for that batch', 'computes the cross-entropy loss for that batch');
  const after = modelOf(edited);
  const hit = Anchor.locate(after.text, selector);
  assert.equal(hit.method, 'fuzzy');
  assert.equal(after.text.slice(hit.start, hit.end), after.text.slice(after.text.indexOf('Each training'), after.text.indexOf('best checkpoint.') + 16));

  const rewritten = md.replace(/reads a batch[\s\S]*?validation loss/, 'is replaced by a closed-form solve because the problem is convex, so no loop over data or optimiser state is needed, and the validation loss');
  assert.equal(Anchor.locate(modelOf(rewritten).text, selector), null);
});

test('a quote that only resembles unrelated text stays orphaned', () => {
  const before = modelOf(LESSON);
  const selector = select(before.text, 'Training moves the parameters so that the loss gets smaller');
  const unrelated = modelOf('## Other\n\nA tokenizer splits raw text into pieces that a model can index.');
  assert.equal(Anchor.locate(unrelated.text, selector), null);
});

test('skipped regions add no text and never join words across blocks', () => {
  const dom = lessonDom('## Build It\n\nFirst paragraph ends here.\n\nSecond paragraph starts here.');
  const heading = dom.findAll(node => node.tagName === 'H2')[0];
  const guide = new ElementNode('p', { class: 'lesson-section-guide' });
  guide.appendChild(new TextNode('Type this code in your own file.'));
  dom.insertBefore(guide, heading.parentNode === dom ? dom.childNodes[dom.childNodes.indexOf(heading) + 1] : null);
  const model = Anchor.buildModel(dom);
  assert.doesNotMatch(model.text, /Type this code/);
  assert.match(model.text, /ends here\. Second paragraph/);
});

test('sections report the nearest preceding heading id and title', () => {
  const model = modelOf(LESSON);
  const at = model.text.indexOf('one parameter');
  const section = Anchor.sectionAt(model, at);
  assert.equal(section.id, 'build-it');
  assert.equal(section.title, 'Build It');
  assert.equal(Anchor.sectionById(model, 'summary').title, 'Summary');
  assert.equal(Anchor.sectionById(model, 'missing'), null);
});

test('wrapping marks text across inline and block elements and unwrapping restores the DOM', () => {
  const dom = lessonDom('## A\n\nOne **two three** four.\n\nFive six seven.');
  const original = dom.textContent;
  let model = Anchor.buildModel(dom);
  const start = model.text.indexOf('three');
  const end = model.text.indexOf('six') + 3;
  const painted = Anchor.wrap(model, start, end, () => new ElementNode('mark', { class: 'aifs-hl' }));
  assert.equal(painted.marks.map(mark => mark.textContent).join('|'), 'three| four.|Five six');
  assert.equal(dom.textContent, original);
  model = Anchor.buildModel(dom);
  assert.equal(model.text.slice(start, end), 'three four. Five six');
  for (const mark of painted.marks) Anchor.unwrap(mark);
  assert.equal(dom.textContent, original);
  assert.equal(dom.findAll(node => node.tagName === 'MARK').length, 0);
  const paragraphs = dom.findAll(node => node.tagName === 'P');
  assert.ok(paragraphs.every(p => p.childNodes.every((child, i, all) => !(child.nodeType === 3 && all[i + 1] && all[i + 1].nodeType === 3))));
});


test('a short quote with hundreds of copies keeps its own place', () => {
  const md = '## Cats\n\n' + Array.from({ length: 700 }, (_, i) => `the cat number ${i} sat.`).join(' ');
  const model = modelOf(md);
  const at = model.text.indexOf('number 650 sat') - 4;
  const selector = Anchor.describe(model.text, at, at + 3);
  assert.equal(selector.quote.exact, 'cat');
  const hit = Anchor.locate(model.text, selector);
  assert.equal(hit.method, 'context');
  assert.equal(hit.start, at);
});

test('a deleted medium quote does not jump to a similar phrase far away', () => {
  const filler = Array.from({ length: 80 }, (_, i) => `Filler sentence ${i} keeps the two passages apart.`).join(' ');
  const md = `## A\n\nWe minimise the loss function here with care.\n\n${filler}\n\n## B\n\nLater we revisit the loss function in detail.`;
  const before = modelOf(md);
  const selector = select(before.text, 'the loss function here');
  const after = modelOf(md.replace(' the loss function here', ''));
  assert.equal(Anchor.locate(after.text, selector), null);
});

test('overlapping highlights wrap from the end with one model and nest cleanly', () => {
  const dom = lessonDom('## A\n\nalpha beta gamma delta epsilon zeta.');
  const original = dom.textContent;
  let model = Anchor.buildModel(dom);
  const text = model.text;
  const ranges = [
    [text.indexOf('gamma'), text.indexOf('zeta') + 4],
    [text.indexOf('beta'), text.indexOf('delta') + 5],
  ];
  let wrappedFrom = Infinity;
  const all = [];
  for (const [start, end] of ranges) {
    if (end > wrappedFrom) model = Anchor.buildModel(dom);
    wrappedFrom = Math.min(wrappedFrom, start);
    all.push(Anchor.wrap(model, start, end, () => new ElementNode('mark', { class: 'aifs-hl' })).marks.map(m => m.textContent).join(''));
  }
  assert.deepEqual(all, ['gamma delta epsilon zeta', 'beta gamma delta']);
  assert.equal(dom.textContent, original);
});

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
  };
}

function fakeWindow(storage) {
  const listeners = {};
  return {
    localStorage: storage,
    addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); },
    dispatch: (name, event) => (listeners[name] || []).forEach(fn => fn(event)),
  };
}

function sampleItem(overrides = {}) {
  return {
    lang: 'en',
    color: 'green',
    note: '',
    quote: { exact: 'steepest increase', prefix: 'direction of ', suffix: ', so we step' },
    position: { start: 120, end: 137, length: 600 },
    section: 'the-problem',
    sectionTitle: 'The Problem',
    ...overrides,
  };
}

const LESSON_PATH = 'phases/01-math-foundations/04-gradient-descent';

test('the store keeps a versioned record under its own localStorage key', () => {
  const storage = memoryStorage();
  const store = StoreModule.create(fakeWindow(storage));
  const item = store.add(LESSON_PATH, sampleItem(), { title: 'Gradient Descent' });
  assert.match(item.id, /^h[a-z0-9]+$/);
  const saved = JSON.parse(storage.getItem('aifs:highlights:v1'));
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.pages[LESSON_PATH].title, 'Gradient Descent');
  assert.equal(saved.pages[LESSON_PATH].items[0].quote.exact, 'steepest increase');
  const updated = store.update(LESSON_PATH, item.id, { color: 'pink', note: 'Sign matters.' });
  assert.equal(updated.color, 'pink');
  assert.equal(updated.createdAt, item.createdAt);
  assert.equal(store.items(LESSON_PATH)[0].note, 'Sign matters.');
  assert.equal(store.remove(LESSON_PATH, item.id), true);
  assert.deepEqual(store.items(LESSON_PATH), []);
  assert.deepEqual(JSON.parse(storage.getItem('aifs:highlights:v1')).pages, {});
});

test('the store rejects unknown colours, bad paths and empty quotes', () => {
  const store = StoreModule.create(fakeWindow(memoryStorage()));
  assert.equal(store.add(LESSON_PATH, sampleItem({ color: 'purple' })).color, 'yellow');
  assert.equal(store.add('../etc/passwd', sampleItem()), null);
  assert.equal(store.add(LESSON_PATH, sampleItem({ quote: { exact: '   ' } })), null);
  assert.equal(store.add(LESSON_PATH, sampleItem({ note: 'x'.repeat(5000) })).note.length, 2000);
});

test('corrupt storage starts empty and keeps the unreadable original', () => {
  const storage = memoryStorage({ 'aifs:highlights:v1': '{not json' });
  const store = StoreModule.create(fakeWindow(storage));
  assert.deepEqual(store.pages(), []);
  assert.equal(store.info().lastError, 'unreadable');
  assert.equal(storage.getItem('aifs:highlights:v1:unreadable'), '{not json');
  store.add(LESSON_PATH, sampleItem());
  assert.equal(storage.getItem('aifs:highlights:v1:unreadable'), '{not json');
  assert.equal(JSON.parse(storage.getItem('aifs:highlights:v1')).pages[LESSON_PATH].items.length, 1);
});

test('invalid items are skipped but the original payload is backed up', () => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    pages: { [LESSON_PATH]: { title: 'GD', items: [{ id: 'good1', quote: { exact: 'kept' } }, { id: 'bad1', quote: {} }, 'junk'] } },
  });
  const storage = memoryStorage({ 'aifs:highlights:v1': raw });
  const store = StoreModule.create(fakeWindow(storage));
  assert.deepEqual(store.items(LESSON_PATH).map(item => item.id), ['good1']);
  assert.equal(store.info().lastError, 'skipped-invalid');
  assert.equal(storage.getItem('aifs:highlights:v1:unreadable'), raw);
});

test('data from a newer schema is shown read-only and never overwritten', () => {
  const raw = JSON.stringify({ schemaVersion: 2, pages: { [LESSON_PATH]: { items: [{ id: 'future', quote: { exact: 'from the future' } }] } } });
  const storage = memoryStorage({ 'aifs:highlights:v1': raw });
  const store = StoreModule.create(fakeWindow(storage));
  assert.equal(store.info().readOnly, true);
  assert.equal(store.items(LESSON_PATH)[0].quote.exact, 'from the future');
  assert.equal(store.add(LESSON_PATH, sampleItem()), null);
  assert.equal(store.add('phases/09-new/01-page', sampleItem()), null);
  assert.equal(store.items(LESSON_PATH).length, 1);
  assert.deepEqual(store.pages().map(page => page.path), [LESSON_PATH]);
  assert.equal(store.remove(LESSON_PATH, 'future'), false);
  assert.equal(storage.getItem('aifs:highlights:v1'), raw);
});

test('blocked storage falls back to memory for the session', () => {
  const win = fakeWindow(null);
  Object.defineProperty(win, 'localStorage', { get() { throw new Error('SecurityError'); } });
  const store = StoreModule.create(win);
  const item = store.add(LESSON_PATH, sampleItem());
  assert.ok(item);
  assert.equal(store.items(LESSON_PATH).length, 1);
  assert.equal(store.info().persistent, false);

  const throwing = memoryStorage();
  throwing.getItem = () => { throw new Error('denied'); };
  const second = StoreModule.create(fakeWindow(throwing));
  assert.ok(second.add(LESSON_PATH, sampleItem()));
  assert.equal(second.info().persistent, false);
});

test('a full quota keeps the highlight for this tab and reports the reason', () => {
  const storage = memoryStorage();
  storage.setItem = () => { const error = new Error('quota'); error.name = 'QuotaExceededError'; throw error; };
  const store = StoreModule.create(fakeWindow(storage));
  assert.ok(store.add(LESSON_PATH, sampleItem()));
  assert.equal(store.items(LESSON_PATH).length, 1);
  assert.equal(store.info().lastError, 'quota');
  assert.equal(store.info().persistent, false);
});

test('anchor refreshes can update quotes without bumping the edit time', () => {
  const store = StoreModule.create(fakeWindow(memoryStorage()));
  const item = store.add(LESSON_PATH, sampleItem());
  store.updateMany(LESSON_PATH, { [item.id]: { status: 'orphaned' } }, true);
  const after = store.items(LESSON_PATH)[0];
  assert.equal(after.status, 'orphaned');
  assert.equal(after.updatedAt, item.updatedAt);
});

test('export and import round-trip, merge by id and keep the newer edit', () => {
  const source = StoreModule.create(fakeWindow(memoryStorage()));
  const first = source.add(LESSON_PATH, sampleItem({ note: 'first' }), { title: 'Gradient Descent' });
  source.add('phases/02-ml/01-regression', sampleItem({ quote: { exact: 'least squares' } }), { title: 'Regression' });
  const exported = JSON.parse(source.exportJson());
  assert.equal(exported.format, 'aifs-highlights');
  assert.equal(exported.schemaVersion, 1);
  assert.deepEqual(Object.keys(exported.pages).sort(), [LESSON_PATH, 'phases/02-ml/01-regression']);
  assert.deepEqual(Object.keys(JSON.parse(source.exportJson([LESSON_PATH])).pages), [LESSON_PATH]);

  const target = StoreModule.create(fakeWindow(memoryStorage()));
  let result = target.importJson(JSON.stringify(exported));
  assert.deepEqual([result.ok, result.added, result.updated, result.unchanged], [true, 2, 0, 0]);
  result = target.importJson(JSON.stringify(exported));
  assert.deepEqual([result.added, result.updated, result.unchanged], [0, 0, 2]);

  exported.pages[LESSON_PATH].items[0].note = 'edited elsewhere';
  exported.pages[LESSON_PATH].items[0].updatedAt = first.updatedAt + 1000;
  exported.pages[LESSON_PATH].items.push({ id: 'broken', quote: {} });
  result = target.importJson(JSON.stringify(exported));
  assert.deepEqual([result.added, result.updated, result.skipped], [0, 1, 1]);
  assert.equal(target.items(LESSON_PATH)[0].note, 'edited elsewhere');
});

test('import refuses files that are not highlight exports', () => {
  const store = StoreModule.create(fakeWindow(memoryStorage()));
  assert.equal(store.importJson('nope').error, 'not-json');
  assert.equal(store.importJson(JSON.stringify({ format: 'something-else', pages: {} })).error, 'wrong-format');
  assert.equal(store.importJson(JSON.stringify({ format: 'aifs-highlights', schemaVersion: 9, pages: {} })).error, 'newer-schema');
  assert.equal(store.importJson(JSON.stringify([1, 2])).error, 'wrong-format');
  assert.deepEqual(store.pages(), []);
});

test('markdown export lists quotes, notes, sections and orphan status', () => {
  const store = StoreModule.create(fakeWindow(memoryStorage()));
  const item = store.add(LESSON_PATH, sampleItem({ note: 'Remember the sign.' }), { title: 'Gradient Descent' });
  store.updateMany(LESSON_PATH, { [item.id]: { status: 'orphaned' } }, true);
  const md = store.exportMarkdown(null, { baseUrl: 'https://example.test/lesson?path=' });
  assert.match(md, /^# Highlights/);
  assert.match(md, /## Gradient Descent/);
  assert.match(md, /Source: https:\/\/example\.test\/lesson\?path=phases%2F01-math-foundations%2F04-gradient-descent/);
  assert.match(md, /> steepest increase/);
  assert.match(md, /Section: The Problem/);
  assert.match(md, /Status: orphaned/);
  assert.match(md, /Note: Remember the sign\./);
});

test('another tab writing the key reloads the store and notifies listeners', () => {
  const storage = memoryStorage();
  const win = fakeWindow(storage);
  const store = StoreModule.create(win);
  let calls = 0;
  assert.equal(store.items(LESSON_PATH).length, 0);
  store.onChange(() => { calls++; });
  const other = StoreModule.create(fakeWindow(storage));
  other.add(LESSON_PATH, sampleItem());
  assert.equal(store.items(LESSON_PATH).length, 0);
  win.dispatch('storage', { key: 'aifs:highlights:v1' });
  assert.equal(store.items(LESSON_PATH).length, 1);
  assert.equal(calls, 1);
});


test('imported language tags are lowercased so they match the page language', () => {
  const store = StoreModule.create(fakeWindow(memoryStorage()));
  assert.equal(store.add(LESSON_PATH, sampleItem({ lang: 'pt-BR' })).lang, 'pt-br');
});

test('the store refuses new highlights past its total size budget', () => {
  const store = StoreModule.create(fakeWindow(memoryStorage()));
  const big = 'x'.repeat(3900);
  let added = 0;
  for (let p = 0; p < 2; p++) {
    for (let i = 0; i < 500; i++) {
      if (store.add(`phases/0${p}-a/${i}-b`, sampleItem({ quote: { exact: big + i } }))) added++;
      else break;
    }
  }
  assert.ok(added < 1000 && added > 300, String(added));
  assert.equal(store.info().lastError, 'full');
  const pagesBefore = store.pages().length;
  assert.equal(store.add('phases/09-new/01-page', sampleItem({ quote: { exact: big } })), null);
  assert.equal(store.pages().length, pagesBefore);
});

test('read-only data is not changed in memory by a refused edit', () => {
  const raw = JSON.stringify({ schemaVersion: 2, pages: { [LESSON_PATH]: { items: [{ id: 'future', color: 'blue', quote: { exact: 'kept' } }] } } });
  const store = StoreModule.create(fakeWindow(memoryStorage({ 'aifs:highlights:v1': raw })));
  assert.equal(store.update(LESSON_PATH, 'future', { color: 'pink' }), null);
  assert.equal(store.updateMany(LESSON_PATH, { future: { status: 'orphaned' } }, true), false);
  assert.equal(store.items(LESSON_PATH)[0].color, 'blue');
  assert.equal(store.importJson(JSON.stringify({ format: 'aifs-highlights', schemaVersion: 1, pages: {} })).error, 'newer-schema');
});

test('a reload from another tab is flagged so the page does not write back', () => {
  const storage = memoryStorage();
  const win = fakeWindow(storage);
  const store = StoreModule.create(win);
  const metas = [];
  store.onChange((_, meta) => metas.push(meta.external === true));
  store.add(LESSON_PATH, sampleItem());
  win.dispatch('storage', { key: 'aifs:highlights:v1' });
  assert.deepEqual(metas, [false, true]);
});

test('the original highlighted text survives a re-anchor and appears in exports', () => {
  const store = StoreModule.create(fakeWindow(memoryStorage()));
  const item = store.add(LESSON_PATH, sampleItem(), { title: 'GD' });
  store.updateMany(LESSON_PATH, { [item.id]: { status: 'moved', originalExact: 'steepest increase', quote: { exact: 'steepest ascent', prefix: '', suffix: '' } } }, true);
  const saved = store.items(LESSON_PATH)[0];
  assert.equal(saved.originalExact, 'steepest increase');
  assert.match(store.exportMarkdown(), /Originally highlighted: steepest increase/);
});

test('the lesson page loads the highlight scripts and mounts after the table of contents', () => {
  const html = fs.readFileSync(path.join(__dirname, 'lesson.html'), 'utf8');
  const order = ['progress.js', 'highlights-anchor.js', 'highlights-store.js', 'highlights.js'].map(name => html.indexOf(`<script src="${name}?v=`));
  assert.ok(order.every(at => at > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(html, /<link rel="stylesheet" href="highlights\.css\?v=/);
  const render = html.slice(html.indexOf('function renderLesson(md)'), html.indexOf('function currentFocusedPathEntry()'));
  assert.ok(render.indexOf('buildTOC();') < render.indexOf('AIFSHighlights.mount('));
  assert.ok(render.indexOf('AIFSHighlights.mount(') < render.indexOf('restoreHeadingHash();'));
  const dispose = html.slice(html.indexOf('function disposeRenderedLesson(root)'), html.indexOf('function restoreHeadingHash()'));
  assert.match(dispose, /AIFSHighlights\.unmount\(\)/);
});

test('the highlight scripts stay dependency free and comment free', () => {
  for (const name of ['highlights-anchor.js', 'highlights-store.js', 'highlights.js']) {
    const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
    assert.doesNotMatch(source, /\brequire\(|^\s*import\s/m, name);
    assert.doesNotMatch(source, /^\s*\/\/|\/\*/m, name);
  }
});
