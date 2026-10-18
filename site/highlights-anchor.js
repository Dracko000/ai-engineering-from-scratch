(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AIFSHighlightAnchor = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var CONTEXT_LENGTH = 32;
  var FUZZY_MIN_LENGTH = 12;
  var FUZZY_MAX_PATTERN = 256;
  var FUZZY_EDGE = 64;
  var FUZZY_THRESHOLD = 0.75;
  var MAX_EXACT_HITS = 500;
  var CONTEXT_TOLERANCE = 0.25;
  var MIN_TOKEN_OVERLAP = 0.5;
  var LONG_MIN_RATIO = 0.7;
  var LONG_MAX_RATIO = 1.4;

  var BLOCK_TAGS = {
    ADDRESS: 1, ARTICLE: 1, ASIDE: 1, BLOCKQUOTE: 1, BR: 1, DD: 1, DETAILS: 1, DIV: 1, DL: 1, DT: 1,
    FIGCAPTION: 1, FIGURE: 1, FOOTER: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, HEADER: 1, HR: 1,
    LI: 1, MAIN: 1, OL: 1, P: 1, PRE: 1, SECTION: 1, SUMMARY: 1, TABLE: 1, TBODY: 1, TD: 1, TFOOT: 1,
    TH: 1, THEAD: 1, TR: 1, UL: 1
  };
  var SKIP_TAGS = {
    BUTTON: 1, CANVAS: 1, INPUT: 1, NAV: 1, NOSCRIPT: 1, SCRIPT: 1, SELECT: 1, STYLE: 1, SVG: 1,
    svg: 1, TEMPLATE: 1, TEXTAREA: 1
  };
  var SKIP_CLASSES = [
    'ai-panels', 'aifs-hl-ui', 'code-copy', 'code-lang', 'lesson-action-panel', 'lesson-figure',
    'lesson-nav-bottom', 'lesson-section-guide', 'mermaid-container', 'quiz-section'
  ];
  var ATOMIC_CLASSES = ['math-inline', 'math-display'];
  var WHITESPACE = /[\s\u00a0\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
  var INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff]/;

  function classList(el) {
    var value = el && el.getAttribute ? el.getAttribute('class') : '';
    return String(value || '').split(/\s+/);
  }

  function hasAnyClass(el, names) {
    var list = classList(el);
    for (var i = 0; i < names.length; i++) {
      if (list.indexOf(names[i]) >= 0) return true;
    }
    return false;
  }

  function normalize(raw) {
    raw = String(raw || '');
    var out = [];
    var map = [];
    var pendingSpace = -1;
    for (var i = 0; i < raw.length; i++) {
      var ch = raw.charAt(i);
      if (INVISIBLE.test(ch)) continue;
      if (WHITESPACE.test(ch)) {
        if (pendingSpace < 0 && out.length) pendingSpace = i;
        continue;
      }
      if (pendingSpace >= 0) {
        out.push(' ');
        map.push(pendingSpace);
        pendingSpace = -1;
      }
      out.push(ch);
      map.push(i);
    }
    return { text: out.join(''), map: map, rawLength: raw.length };
  }

  function normalizeQuote(text) {
    return normalize(text).text;
  }

  function lowerBound(values, target) {
    var lo = 0;
    var hi = values.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (values[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function rawToNormalized(normalized, rawStart, rawEnd) {
    var start = lowerBound(normalized.map, rawStart);
    var end = lowerBound(normalized.map, rawEnd);
    var text = normalized.text;
    while (start < end && text.charAt(start) === ' ') start++;
    while (end > start && text.charAt(end - 1) === ' ') end--;
    return { start: start, end: end };
  }

  function normalizedToRaw(normalized, start, end) {
    if (start >= end || !normalized.map.length) return null;
    return { start: normalized.map[start], end: normalized.map[end - 1] + 1 };
  }

  function describe(text, start, end) {
    return {
      quote: {
        exact: text.slice(start, end),
        prefix: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
        suffix: text.slice(end, end + CONTEXT_LENGTH)
      },
      position: { start: start, end: end, length: text.length }
    };
  }

  function commonSuffixLength(a, b) {
    var n = 0;
    while (n < a.length && n < b.length && a.charAt(a.length - 1 - n) === b.charAt(b.length - 1 - n)) n++;
    return n;
  }

  function commonPrefixLength(a, b) {
    var n = 0;
    while (n < a.length && n < b.length && a.charAt(n) === b.charAt(n)) n++;
    return n;
  }

  function findAll(text, exact) {
    var hits = [];
    var from = 0;
    while (hits.length < MAX_EXACT_HITS) {
      var at = text.indexOf(exact, from);
      if (at < 0) break;
      hits.push(at);
      from = at + 1;
    }
    return hits;
  }

  function expectedStart(text, position) {
    if (!position || !Number.isFinite(position.start)) return -1;
    var oldLength = Number(position.length) > 0 ? Number(position.length) : text.length;
    return Math.round(position.start * (text.length / oldLength));
  }

  function contextScore(text, at, exact, quote) {
    var prefix = quote.prefix || '';
    var suffix = quote.suffix || '';
    var before = text.slice(Math.max(0, at - prefix.length), at);
    var after = text.slice(at + exact.length, at + exact.length + suffix.length);
    var prefixScore = prefix.length ? commonSuffixLength(before, prefix) / prefix.length : 1;
    var suffixScore = suffix.length ? commonPrefixLength(after, suffix) / suffix.length : 1;
    return { full: before === prefix && after === suffix, score: prefixScore + suffixScore };
  }

  function pickNearest(candidates, target) {
    var best = candidates[0];
    if (target < 0) return best;
    for (var i = 1; i < candidates.length; i++) {
      if (Math.abs(candidates[i].start - target) < Math.abs(best.start - target)) best = candidates[i];
    }
    return best;
  }

  function locateExact(text, quote, target) {
    var exact = quote.exact;
    var hits = findAll(text, exact);
    if (!hits.length) return null;
    var full = [];
    var scored = [];
    for (var i = 0; i < hits.length; i++) {
      var context = contextScore(text, hits[i], exact, quote);
      var candidate = { start: hits[i], end: hits[i] + exact.length, score: context.score };
      if (context.full) full.push(candidate);
      scored.push(candidate);
    }
    if (full.length) {
      var exactContext = pickNearest(full, target);
      return { start: exactContext.start, end: exactContext.end, method: 'context', score: 1 };
    }
    var topScore = -1;
    for (var j = 0; j < scored.length; j++) topScore = Math.max(topScore, scored[j].score);
    var top = scored.filter(function (candidate) { return candidate.score >= topScore - CONTEXT_TOLERANCE; });
    var chosen = pickNearest(top, target);
    return { start: chosen.start, end: chosen.end, method: 'quote', score: 1 };
  }

  function bestEnd(text, from, to, pattern, maxErrors, target) {
    var m = pattern.length;
    var previous = new Int32Array(m + 1);
    var current = new Int32Array(m + 1);
    for (var i = 0; i <= m; i++) previous[i] = i;
    var best = { errors: maxErrors + 1, end: -1 };
    for (var j = from; j < to; j++) {
      var ch = text.charCodeAt(j);
      current[0] = 0;
      for (var k = 1; k <= m; k++) {
        var cost = pattern.charCodeAt(k - 1) === ch ? 0 : 1;
        var value = previous[k - 1] + cost;
        if (previous[k] + 1 < value) value = previous[k] + 1;
        if (current[k - 1] + 1 < value) value = current[k - 1] + 1;
        current[k] = value;
      }
      var errors = current[m];
      if (errors < best.errors || (errors === best.errors && best.end >= 0 && target >= 0 &&
          Math.abs(j + 1 - target) < Math.abs(best.end - target))) {
        best = { errors: errors, end: j + 1 };
      }
      var swap = previous;
      previous = current;
      current = swap;
    }
    return best.end < 0 ? null : best;
  }

  function reverse(value) {
    return value.split('').reverse().join('');
  }

  function fuzzySpan(text, from, to, pattern, target) {
    var maxErrors = Math.floor(pattern.length * (1 - FUZZY_THRESHOLD));
    from = Math.max(0, from);
    to = Math.min(text.length, to);
    if (to - from < pattern.length - maxErrors) return null;
    var endHit = bestEnd(text, from, to, pattern, maxErrors, target < 0 ? -1 : target + pattern.length);
    if (!endHit) return null;
    var lo = Math.max(from, endHit.end - pattern.length - maxErrors);
    var segment = reverse(text.slice(lo, endHit.end));
    var startHit = bestEnd(segment, 0, segment.length, reverse(pattern), maxErrors, -1);
    if (!startHit) return null;
    var start = endHit.end - startHit.end;
    return { start: start, end: endHit.end, score: 1 - endHit.errors / pattern.length };
  }

  function trimSpan(text, span) {
    var start = span.start;
    var end = span.end;
    while (start < end && text.charAt(start) === ' ') start++;
    while (end > start && text.charAt(end - 1) === ' ') end--;
    span.start = start;
    span.end = end;
    return span;
  }

  function words(value) {
    var counts = {};
    var total = 0;
    var list = String(value).toLowerCase().split(/[^a-z0-9\u00c0-\uffff]+/);
    for (var i = 0; i < list.length; i++) {
      if (!list[i]) continue;
      counts[list[i]] = (counts[list[i]] || 0) + 1;
      total++;
    }
    return { counts: counts, total: total };
  }

  function tokenOverlap(a, b) {
    var left = words(a);
    var right = words(b);
    if (!left.total || !right.total) return 0;
    var common = 0;
    for (var word in left.counts) {
      if (Object.prototype.hasOwnProperty.call(right.counts, word)) common += Math.min(left.counts[word], right.counts[word]);
    }
    return (2 * common) / (left.total + right.total);
  }

  function fuzzyLong(text, from, to, exact, target) {
    var headPattern = exact.slice(0, FUZZY_EDGE);
    var tailPattern = exact.slice(-FUZZY_EDGE);
    var minLength = Math.floor(exact.length * LONG_MIN_RATIO);
    var maxLength = Math.ceil(exact.length * LONG_MAX_RATIO);
    function fits(head, tail) {
      return head && tail && tail.end > head.start && tail.end - head.start >= minLength && tail.end - head.start <= maxLength;
    }
    var tailTarget = target >= 0 ? target + exact.length - FUZZY_EDGE : -1;
    var head = fuzzySpan(text, from, to, headPattern, target);
    var tail = fuzzySpan(text, from, to, tailPattern, tailTarget);
    if (head && !fits(head, tail)) {
      var tailAfterHead = fuzzySpan(text, head.start + minLength - FUZZY_EDGE, Math.min(to, head.start + maxLength), tailPattern, head.start + exact.length - FUZZY_EDGE);
      if (fits(head, tailAfterHead)) tail = tailAfterHead;
    }
    if (tail && !fits(head, tail)) {
      var headBeforeTail = fuzzySpan(text, Math.max(from, tail.end - maxLength), tail.end - minLength + FUZZY_EDGE, headPattern, tail.end - exact.length);
      if (fits(headBeforeTail, tail)) head = headBeforeTail;
    }
    if (!fits(head, tail)) return null;
    var overlap = tokenOverlap(exact, text.slice(head.start, tail.end));
    return { start: head.start, end: tail.end, score: Math.min(head.score, tail.score, overlap) };
  }

  function fuzzyInRegion(text, exact, from, to, target) {
    if (exact.length <= FUZZY_MAX_PATTERN) {
      var span = fuzzySpan(text, from, to, exact, target);
      if (span && tokenOverlap(exact, text.slice(span.start, span.end)) < MIN_TOKEN_OVERLAP) return null;
      return span;
    }
    return fuzzyLong(text, Math.max(0, from), Math.min(text.length, to), exact, target);
  }

  function locateFuzzy(text, quote, target, regions) {
    var exact = quote.exact;
    if (exact.length < FUZZY_MIN_LENGTH) return null;
    var slack = Math.max(2000, exact.length * 4);
    var tries = [];
    for (var i = 0; i < regions.length; i++) {
      if (regions[i] && regions[i].end > regions[i].start) tries.push(regions[i]);
    }
    if (target >= 0) tries.push({ start: target - slack, end: target + exact.length + slack });
    tries.push({ start: 0, end: text.length });
    for (var j = 0; j < tries.length; j++) {
      var span = fuzzyInRegion(text, exact, tries[j].start - exact.length, tries[j].end + exact.length, target);
      if (span && span.score >= FUZZY_THRESHOLD) {
        trimSpan(text, span);
        if (span.end > span.start) return { start: span.start, end: span.end, method: 'fuzzy', score: span.score };
      }
    }
    return null;
  }

  function locate(text, selector, options) {
    options = options || {};
    var quote = selector && selector.quote;
    if (!quote || typeof quote.exact !== 'string' || !quote.exact) return null;
    var target = expectedStart(text, selector.position);
    var exact = locateExact(text, quote, target);
    if (exact) return exact;
    return locateFuzzy(text, quote, target, options.regions || []);
  }

  function isElement(node) {
    return node && node.nodeType === 1;
  }

  function isSkipped(el) {
    if (SKIP_TAGS[el.tagName]) return true;
    if (hasAnyClass(el, SKIP_CLASSES)) return true;
    if (el.tagName === 'SUMMARY' && el.parentNode && hasAnyClass(el.parentNode, ['lesson-hints'])) return true;
    return false;
  }

  function isAtomic(el) {
    return hasAnyClass(el, ATOMIC_CLASSES);
  }

  function atomicText(el) {
    var annotation = el.querySelector ? el.querySelector('annotation[encoding="application/x-tex"]') : null;
    var tex = annotation ? annotation.textContent : el.textContent;
    return ' ' + String(tex || '').trim() + ' ';
  }

  function buildModel(rootNode) {
    var segments = [];
    var sections = [];
    var parts = [];
    var length = 0;

    function push(node, text, atomic) {
      if (!text) return;
      segments.push({ node: node, start: length, end: length + text.length, atomic: !!atomic });
      parts.push(text);
      length += text.length;
    }

    function boundary() {
      if (parts.length && parts[parts.length - 1] !== ' ') push(null, ' ', false);
    }

    function walk(node) {
      if (node.nodeType === 3) {
        push(node, node.nodeValue, false);
        return;
      }
      if (!isElement(node)) return;
      if (isSkipped(node)) {
        boundary();
        return;
      }
      if (isAtomic(node)) {
        push(node, atomicText(node), true);
        return;
      }
      var block = !!BLOCK_TAGS[node.tagName];
      if (block) boundary();
      if ((node.tagName === 'H2' || node.tagName === 'H3') && node.id) {
        sections.push({ id: node.id, rawStart: length, title: normalizeQuote(node.textContent).slice(0, 120) });
      }
      var children = node.childNodes || [];
      for (var i = 0; i < children.length; i++) walk(children[i]);
      if (block) boundary();
    }

    var children = rootNode.childNodes || [];
    for (var c = 0; c < children.length; c++) walk(children[c]);

    var raw = parts.join('');
    var normalized = normalize(raw);
    for (var s = 0; s < sections.length; s++) {
      sections[s].start = lowerBound(normalized.map, sections[s].rawStart);
    }
    for (var t = 0; t < sections.length; t++) {
      sections[t].end = t + 1 < sections.length ? sections[t + 1].start : normalized.text.length;
    }
    return { raw: raw, text: normalized.text, normalized: normalized, segments: segments, sections: sections };
  }

  function sectionAt(model, offset) {
    var found = null;
    for (var i = 0; i < model.sections.length; i++) {
      if (model.sections[i].start <= offset) found = model.sections[i];
      else break;
    }
    return found;
  }

  function sectionById(model, id) {
    if (!id) return null;
    for (var i = 0; i < model.sections.length; i++) {
      if (model.sections[i].id === id) return model.sections[i];
    }
    return null;
  }

  function segmentsBetween(model, rawStart, rawEnd) {
    var out = [];
    for (var i = 0; i < model.segments.length; i++) {
      var segment = model.segments[i];
      if (segment.end <= rawStart) continue;
      if (segment.start >= rawEnd) break;
      if (!segment.node) continue;
      out.push({
        segment: segment,
        from: Math.max(0, rawStart - segment.start),
        to: Math.min(segment.end, rawEnd) - segment.start
      });
    }
    return out;
  }

  function isPhrasingParent(node) {
    var parent = node.parentNode;
    if (!parent || !parent.tagName) return false;
    return !/^(UL|OL|TABLE|TBODY|THEAD|TFOOT|TR|DL|SELECT)$/.test(parent.tagName);
  }

  function wrap(model, start, end, createMark) {
    var raw = normalizedToRaw(model.normalized, start, end);
    if (!raw) return { marks: [], atoms: [] };
    var pieces = segmentsBetween(model, raw.start, raw.end);
    var marks = [];
    var atoms = [];
    for (var i = 0; i < pieces.length; i++) {
      var piece = pieces[i];
      var node = piece.segment.node;
      if (piece.segment.atomic) {
        atoms.push(node);
        continue;
      }
      var value = node.nodeValue || '';
      var slice = value.slice(piece.from, piece.to);
      if (!slice || !/\S/.test(slice) || !isPhrasingParent(node)) continue;
      var target = node;
      if (piece.to < value.length) target.splitText(piece.to);
      if (piece.from > 0) target = target.splitText(piece.from);
      var mark = createMark(marks.length);
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
      marks.push(mark);
    }
    return { marks: marks, atoms: atoms };
  }

  function unwrap(mark) {
    var parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    if (parent.normalize) parent.normalize();
  }

  return {
    CONTEXT_LENGTH: CONTEXT_LENGTH,
    FUZZY_THRESHOLD: FUZZY_THRESHOLD,
    normalize: normalize,
    normalizeQuote: normalizeQuote,
    rawToNormalized: rawToNormalized,
    normalizedToRaw: normalizedToRaw,
    describe: describe,
    locate: locate,
    buildModel: buildModel,
    sectionAt: sectionAt,
    sectionById: sectionById,
    wrap: wrap,
    unwrap: unwrap
  };
}));
