(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AIFSHighlightStore = api.create(root);
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var STORAGE_KEY = 'aifs:highlights:v1';
  var BACKUP_KEY = 'aifs:highlights:v1:unreadable';
  var SCHEMA_VERSION = 1;
  var EXPORT_FORMAT = 'aifs-highlights';
  var COLORS = ['yellow', 'green', 'blue', 'pink'];
  var STATUSES = ['anchored', 'moved', 'orphaned'];
  var MAX_ITEMS_PER_PAGE = 500;
  var MAX_EXACT = 4000;
  var MAX_CONTEXT = 64;
  var MAX_NOTE = 2000;
  var MAX_TITLE = 200;
  var MAX_BYTES = 1500000;
  var PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,299}$/;

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function timestamp(value) {
    var n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function text(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
  }

  function offset(value) {
    var n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  function newId() {
    return 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function emptyState() {
    return { schemaVersion: SCHEMA_VERSION, pages: {}, updatedAt: 0 };
  }

  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var quote = raw.quote && typeof raw.quote === 'object' ? raw.quote : {};
    var exact = text(quote.exact, MAX_EXACT);
    if (!exact.trim()) return null;
    var id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.id) ? raw.id : newId();
    var position = raw.position && typeof raw.position === 'object' ? raw.position : {};
    var start = offset(position.start);
    var end = Math.max(start, offset(position.end));
    var createdAt = timestamp(raw.createdAt) || Date.now();
    return {
      id: id,
      lang: typeof raw.lang === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(raw.lang.toLowerCase()) ? raw.lang.toLowerCase() : 'en',
      color: COLORS.indexOf(raw.color) >= 0 ? raw.color : COLORS[0],
      note: text(raw.note, MAX_NOTE),
      quote: {
        exact: exact,
        prefix: text(quote.prefix, MAX_CONTEXT),
        suffix: text(quote.suffix, MAX_CONTEXT)
      },
      position: { start: start, end: end, length: offset(position.length) },
      section: text(raw.section, 200),
      sectionTitle: text(raw.sectionTitle, MAX_TITLE),
      originalExact: text(raw.originalExact, MAX_EXACT),
      orphanHash: text(raw.orphanHash, 40),
      status: STATUSES.indexOf(raw.status) >= 0 ? raw.status : 'anchored',
      createdAt: createdAt,
      updatedAt: timestamp(raw.updatedAt) || createdAt
    };
  }

  function normalizePage(raw) {
    var page = { title: '', items: [] };
    if (!raw || typeof raw !== 'object') return { page: page, skipped: 0 };
    page.title = text(raw.title, MAX_TITLE);
    var items = Array.isArray(raw.items) ? raw.items : [];
    var seen = {};
    var skipped = 0;
    for (var i = 0; i < items.length; i++) {
      var item = normalizeItem(items[i]);
      if (!item || seen[item.id] || page.items.length >= MAX_ITEMS_PER_PAGE) {
        skipped++;
        continue;
      }
      seen[item.id] = true;
      page.items.push(item);
    }
    return { page: page, skipped: skipped };
  }

  function normalizeState(raw) {
    var state = emptyState();
    var skipped = 0;
    if (!raw || typeof raw !== 'object' || !raw.pages || typeof raw.pages !== 'object' || Array.isArray(raw.pages)) {
      return { state: state, skipped: 0, valid: false };
    }
    for (var path in raw.pages) {
      if (!own(raw.pages, path)) continue;
      if (!PATH_PATTERN.test(path)) {
        skipped++;
        continue;
      }
      var result = normalizePage(raw.pages[path]);
      skipped += result.skipped;
      if (result.page.items.length) state.pages[path] = result.page;
    }
    state.updatedAt = timestamp(raw.updatedAt);
    return { state: state, skipped: skipped, valid: true };
  }

  function exportPayload(state, paths) {
    var pages = {};
    var list = paths || Object.keys(state.pages);
    for (var i = 0; i < list.length; i++) {
      if (own(state.pages, list[i])) pages[list[i]] = state.pages[list[i]];
    }
    return {
      format: EXPORT_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      pages: pages
    };
  }

  function markdownLine(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function toMarkdown(state, paths, options) {
    options = options || {};
    var base = options.baseUrl || 'https://aiengineeringfromscratch.com/lesson?path=';
    var list = paths || Object.keys(state.pages).sort();
    var out = ['# Highlights', ''];
    var count = 0;
    for (var i = 0; i < list.length; i++) {
      var page = state.pages[list[i]];
      if (!page || !page.items.length) continue;
      out.push('## ' + markdownLine(page.title || list[i]), '');
      out.push('Source: ' + base + encodeURIComponent(list[i]), '');
      for (var j = 0; j < page.items.length; j++) {
        var item = page.items[j];
        count++;
        out.push('> ' + markdownLine(item.quote.exact), '');
        if (item.originalExact && item.originalExact !== item.quote.exact) {
          out.push('Originally highlighted: ' + markdownLine(item.originalExact), '');
        }
        var meta = ['Colour: ' + item.color];
        if (item.sectionTitle) meta.push('Section: ' + markdownLine(item.sectionTitle));
        if (item.lang !== 'en') meta.push('Language: ' + item.lang);
        if (item.status === 'orphaned') meta.push('Status: orphaned (the lesson text changed)');
        out.push(meta.join(' \u00b7 '), '');
        if (item.note) out.push('Note: ' + markdownLine(item.note), '');
      }
    }
    if (!count) out.push('No highlights yet.', '');
    return out.join('\n');
  }

  function create(win) {
    var storage = null;
    try {
      storage = win && win.localStorage ? win.localStorage : null;
    } catch (_) {
      storage = null;
    }
    var memory = null;
    var persistent = !!storage;
    var readOnly = false;
    var lastError = '';
    var listeners = [];

    function backupUnreadable(raw) {
      if (!storage) return;
      try {
        if (!storage.getItem(BACKUP_KEY)) storage.setItem(BACKUP_KEY, raw);
      } catch (_) {}
    }

    function load() {
      if (memory) return memory;
      var raw = null;
      if (storage) {
        try {
          raw = storage.getItem(STORAGE_KEY);
        } catch (_) {
          persistent = false;
          storage = null;
        }
      }
      if (!raw) {
        memory = emptyState();
        return memory;
      }
      var parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        parsed = null;
      }
      if (parsed && typeof parsed === 'object' && Number(parsed.schemaVersion) > SCHEMA_VERSION) {
        readOnly = true;
        lastError = 'newer-schema';
        memory = normalizeState(parsed).state;
        return memory;
      }
      var result = normalizeState(parsed);
      if (!result.valid || result.skipped) {
        backupUnreadable(raw);
        lastError = result.valid ? 'skipped-invalid' : 'unreadable';
      }
      memory = result.state;
      return memory;
    }

    function notify(meta) {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](memory, meta || {}); } catch (_) {}
      }
    }

    function size(state) {
      try {
        return JSON.stringify(state).length;
      } catch (_) {
        return Infinity;
      }
    }

    function save(state) {
      if (readOnly) {
        lastError = 'newer-schema';
        return false;
      }
      state.schemaVersion = SCHEMA_VERSION;
      state.updatedAt = Date.now();
      memory = state;
      if (storage) {
        try {
          storage.setItem(STORAGE_KEY, JSON.stringify(state));
          persistent = true;
          if (lastError === 'quota' || lastError === 'write-failed') lastError = '';
        } catch (error) {
          persistent = false;
          lastError = error && /quota/i.test(String(error.name || error.message)) ? 'quota' : 'write-failed';
        }
      }
      notify();
      return true;
    }

    function page(path) {
      var state = load();
      return own(state.pages, path) ? state.pages[path] : null;
    }

    function items(path) {
      var current = page(path);
      return current ? current.items.slice() : [];
    }

    function add(path, raw, meta) {
      if (!PATH_PATTERN.test(String(path || ''))) return null;
      var item = normalizeItem(Object.assign({}, raw, { id: newId(), createdAt: Date.now(), updatedAt: Date.now() }));
      if (!item) return null;
      var state = load();
      if (readOnly) {
        lastError = 'newer-schema';
        return null;
      }
      var existing = own(state.pages, path) ? state.pages[path] : null;
      if (existing && existing.items.length >= MAX_ITEMS_PER_PAGE) {
        lastError = 'page-full';
        return null;
      }
      if (size(state) + size(item) > MAX_BYTES) {
        lastError = 'full';
        return null;
      }
      if (!existing) state.pages[path] = { title: '', items: [] };
      var target = state.pages[path];
      if (meta && meta.title) target.title = text(meta.title, MAX_TITLE);
      target.items.push(item);
      target.items.sort(function (a, b) { return a.position.start - b.position.start; });
      return save(state) ? item : null;
    }

    function update(path, id, patch) {
      if (load() && readOnly) {
        lastError = 'newer-schema';
        return null;
      }
      var current = page(path);
      if (!current) return null;
      for (var i = 0; i < current.items.length; i++) {
        if (current.items[i].id !== id) continue;
        var merged = normalizeItem(Object.assign({}, current.items[i], patch, { id: id, updatedAt: Date.now() }));
        if (!merged) return null;
        merged.createdAt = current.items[i].createdAt;
        current.items[i] = merged;
        return save(load()) ? merged : null;
      }
      return null;
    }

    function updateMany(path, patches, silentTimestamp) {
      if (load() && readOnly) return false;
      var current = page(path);
      if (!current) return false;
      var changed = false;
      for (var i = 0; i < current.items.length; i++) {
        var patch = patches[current.items[i].id];
        if (!patch) continue;
        var merged = normalizeItem(Object.assign({}, current.items[i], patch));
        if (!merged) continue;
        if (!silentTimestamp) merged.updatedAt = Date.now();
        current.items[i] = merged;
        changed = true;
      }
      if (!changed) return false;
      current.items.sort(function (a, b) { return a.position.start - b.position.start; });
      return save(load());
    }

    function remove(path, id) {
      var state = load();
      if (readOnly) return false;
      var current = own(state.pages, path) ? state.pages[path] : null;
      if (!current) return false;
      var before = current.items.length;
      current.items = current.items.filter(function (item) { return item.id !== id; });
      if (current.items.length === before) return false;
      if (!current.items.length) delete state.pages[path];
      return save(state);
    }

    function pages() {
      var state = load();
      return Object.keys(state.pages).sort().map(function (path) {
        return { path: path, title: state.pages[path].title, items: state.pages[path].items.slice() };
      });
    }

    function exportJson(paths) {
      return JSON.stringify(exportPayload(load(), paths), null, 2);
    }

    function exportMarkdown(paths, options) {
      return toMarkdown(load(), paths, options);
    }

    function importJson(source) {
      var parsed = null;
      try {
        parsed = typeof source === 'string' ? JSON.parse(source) : source;
      } catch (_) {
        return { ok: false, error: 'not-json', added: 0, updated: 0, unchanged: 0, skipped: 0 };
      }
      if (!parsed || typeof parsed !== 'object' || (parsed.format && parsed.format !== EXPORT_FORMAT)) {
        return { ok: false, error: 'wrong-format', added: 0, updated: 0, unchanged: 0, skipped: 0 };
      }
      if (Number(parsed.schemaVersion) > SCHEMA_VERSION) {
        return { ok: false, error: 'newer-schema', added: 0, updated: 0, unchanged: 0, skipped: 0 };
      }
      var incoming = normalizeState(parsed);
      if (!incoming.valid) {
        return { ok: false, error: 'wrong-format', added: 0, updated: 0, unchanged: 0, skipped: 0 };
      }
      var state = load();
      if (readOnly) return { ok: false, error: 'newer-schema', added: 0, updated: 0, unchanged: 0, skipped: 0 };
      var snapshot = JSON.stringify(state);
      var result = { ok: true, error: '', added: 0, updated: 0, unchanged: 0, skipped: incoming.skipped };
      for (var path in incoming.state.pages) {
        if (!own(incoming.state.pages, path)) continue;
        var source = incoming.state.pages[path];
        if (!own(state.pages, path)) state.pages[path] = { title: source.title, items: [] };
        var target = state.pages[path];
        if (!target.title && source.title) target.title = source.title;
        for (var i = 0; i < source.items.length; i++) {
          var item = source.items[i];
          var index = -1;
          for (var j = 0; j < target.items.length; j++) {
            if (target.items[j].id === item.id) { index = j; break; }
          }
          if (index < 0) {
            if (target.items.length >= MAX_ITEMS_PER_PAGE) { result.skipped++; continue; }
            target.items.push(item);
            result.added++;
          } else if (item.updatedAt > target.items[index].updatedAt) {
            target.items[index] = item;
            result.updated++;
          } else {
            result.unchanged++;
          }
        }
        target.items.sort(function (a, b) { return a.position.start - b.position.start; });
        if (!target.items.length) delete state.pages[path];
      }
      if (size(state) > MAX_BYTES) {
        memory = JSON.parse(snapshot);
        return { ok: false, error: 'too-large', added: 0, updated: 0, unchanged: 0, skipped: 0 };
      }
      if (result.added || result.updated) result.ok = save(state);
      return result;
    }

    function onChange(fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.push(fn);
      return function () {
        var index = listeners.indexOf(fn);
        if (index >= 0) listeners.splice(index, 1);
      };
    }

    function reload() {
      memory = null;
      readOnly = false;
      load();
      notify({ external: true });
    }

    if (win && win.addEventListener) {
      win.addEventListener('storage', function (event) {
        if (event.key === STORAGE_KEY) reload();
      });
    }

    return {
      COLORS: COLORS.slice(),
      STORAGE_KEY: STORAGE_KEY,
      items: items,
      page: page,
      pages: pages,
      add: add,
      update: update,
      updateMany: updateMany,
      remove: remove,
      exportJson: exportJson,
      exportMarkdown: exportMarkdown,
      importJson: importJson,
      onChange: onChange,
      reload: reload,
      info: function () {
        load();
        return { persistent: persistent, readOnly: readOnly, lastError: lastError };
      }
    };
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    BACKUP_KEY: BACKUP_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    COLORS: COLORS,
    normalizeItem: normalizeItem,
    normalizeState: normalizeState,
    toMarkdown: toMarkdown,
    create: create
  };
}));
