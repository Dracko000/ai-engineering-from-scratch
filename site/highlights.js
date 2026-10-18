(function () {
  'use strict';

  var Anchor = window.AIFSHighlightAnchor;
  var Store = window.AIFSHighlightStore;
  if (!Anchor || !Store || !document.createRange || !window.getSelection) return;

  var COLORS = Store.COLORS;
  var COLOR_LABELS = { yellow: 'Yellow', green: 'Green', blue: 'Blue', pink: 'Pink' };
  var MAX_SELECTION = 4000;
  var QUOTE_PREVIEW = 240;

  var state = {
    article: null,
    ctx: null,
    pending: null,
    runtime: {},
    painting: false,
    bound: false,
    tab: 'page',
    editor: null,
    selectionTimer: 0,
    orphanCache: {}
  };
  var ui = {};

  function make(tag, className, attrs) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) node.setAttribute(key, attrs[key]);
      }
    }
    return node;
  }

  function button(className, label, attrs) {
    var node = make('button', className, attrs);
    node.type = 'button';
    node.textContent = label;
    return node;
  }

  function announce(message) {
    if (!ui.live) return;
    ui.live.textContent = '';
    window.setTimeout(function () { ui.live.textContent = message; }, 30);
  }

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function coarsePointer() {
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  }

  function langOf(item) {
    return item.lang || 'en';
  }

  function currentItems() {
    return state.ctx ? Store.items(state.ctx.path) : [];
  }

  function findItem(id) {
    var items = currentItems();
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) return items[i];
    }
    return null;
  }

  function preview(text) {
    var value = String(text || '');
    return value.length > QUOTE_PREVIEW ? value.slice(0, QUOTE_PREVIEW - 1) + '\u2026' : value;
  }

  function lessonHref(path, id) {
    return 'lesson.html?path=' + encodeURIComponent(path) + (id ? '#hl-' + id : '');
  }

  function ensureUi() {
    if (ui.root) return;
    ui.root = make('div', 'aifs-hl-ui aifs-hl-layer');

    ui.live = make('div', 'aifs-hl-sr', { 'aria-live': 'polite', role: 'status' });
    ui.hint = make('span', 'aifs-hl-sr', { id: 'aifsHlMarkHint' });
    ui.hint.textContent = 'Highlighted text. Press Enter to change the colour or note.';

    ui.toolbar = make('div', 'aifs-hl-toolbar aifs-hl-ui', { role: 'toolbar', 'aria-label': 'Highlight the selected text' });
    ui.toolbar.hidden = true;
    COLORS.forEach(function (color) {
      var swatch = button('aifs-hl-swatch-btn aifs-hl-bg-' + color, '', {
        'data-color': color,
        'aria-label': 'Highlight ' + COLOR_LABELS[color].toLowerCase(),
        title: 'Highlight ' + COLOR_LABELS[color].toLowerCase()
      });
      ui.toolbar.appendChild(swatch);
    });
    ui.toolbarNote = button('aifs-hl-tool-text', 'Note', { 'data-note': 'true', title: 'Highlight and add a note' });
    ui.toolbar.appendChild(ui.toolbarNote);

    ui.editor = make('div', 'aifs-hl-editor aifs-hl-ui', { role: 'dialog', 'aria-label': 'Edit highlight' });
    ui.editor.hidden = true;
    var colorRow = make('div', 'aifs-hl-editor-colors', { role: 'group', 'aria-label': 'Colour' });
    COLORS.forEach(function (color) {
      colorRow.appendChild(button('aifs-hl-swatch-btn aifs-hl-bg-' + color, '', {
        'data-color': color,
        'aria-label': COLOR_LABELS[color],
        'aria-pressed': 'false',
        title: COLOR_LABELS[color]
      }));
    });
    var noteLabel = make('label', 'aifs-hl-editor-label', { for: 'aifsHlNote' });
    noteLabel.textContent = 'Note';
    ui.editorNote = make('textarea', 'aifs-hl-editor-note', { id: 'aifsHlNote', rows: '3', maxlength: '2000', placeholder: 'Why this matters to you' });
    ui.editorStatus = make('p', 'aifs-hl-editor-status');
    var editorActions = make('div', 'aifs-hl-editor-actions');
    ui.editorSave = button('aifs-hl-btn aifs-hl-btn-primary', 'Save note');
    ui.editorDelete = button('aifs-hl-btn aifs-hl-btn-danger', 'Delete');
    ui.editorClose = button('aifs-hl-btn', 'Close');
    editorActions.appendChild(ui.editorSave);
    editorActions.appendChild(ui.editorDelete);
    editorActions.appendChild(ui.editorClose);
    ui.editor.appendChild(colorRow);
    ui.editor.appendChild(noteLabel);
    ui.editor.appendChild(ui.editorNote);
    ui.editor.appendChild(ui.editorStatus);
    ui.editor.appendChild(editorActions);

    ui.launcher = button('aifs-hl-launch aifs-hl-ui', '', { 'aria-controls': 'aifsHlPanel', 'aria-expanded': 'false' });
    ui.launcherLabel = make('span', 'aifs-hl-launch-label');
    ui.launcherLabel.textContent = 'Highlights';
    ui.launcherCount = make('span', 'aifs-hl-launch-count');
    ui.launcher.appendChild(ui.launcherLabel);
    ui.launcher.appendChild(ui.launcherCount);
    ui.launcher.hidden = true;

    ui.panel = make('div', 'aifs-hl-panel aifs-hl-ui', { id: 'aifsHlPanel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'aifsHlPanelTitle' });
    ui.panel.hidden = true;
    var head = make('div', 'aifs-hl-panel-head');
    var title = make('h2', 'aifs-hl-panel-title', { id: 'aifsHlPanelTitle' });
    title.textContent = 'My highlights';
    ui.panelClose = button('aifs-hl-btn', 'Close');
    head.appendChild(title);
    head.appendChild(ui.panelClose);
    var tabs = make('div', 'aifs-hl-tabs', { role: 'tablist', 'aria-label': 'Highlight scope' });
    ui.tabPage = button('aifs-hl-tab', 'This page', { role: 'tab', id: 'aifsHlTabPage', 'aria-controls': 'aifsHlList', 'data-tab': 'page' });
    ui.tabAll = button('aifs-hl-tab', 'All pages', { role: 'tab', id: 'aifsHlTabAll', 'aria-controls': 'aifsHlList', 'data-tab': 'all' });
    tabs.appendChild(ui.tabPage);
    tabs.appendChild(ui.tabAll);
    ui.panelNotice = make('p', 'aifs-hl-notice');
    ui.panelNotice.hidden = true;
    ui.list = make('div', 'aifs-hl-list', { id: 'aifsHlList', role: 'tabpanel', tabindex: '0' });
    var foot = make('div', 'aifs-hl-panel-foot');
    ui.exportMd = button('aifs-hl-btn', 'Export Markdown');
    ui.exportJson = button('aifs-hl-btn', 'Export JSON');
    ui.importBtn = button('aifs-hl-btn', 'Import JSON');
    ui.importInput = make('input', 'aifs-hl-file', { type: 'file', accept: 'application/json,.json', tabindex: '-1', 'aria-hidden': 'true' });
    ui.footNote = make('p', 'aifs-hl-foot-note');
    ui.footNote.textContent = 'Highlights stay in this browser. Export them to keep a copy or move them to another device.';
    foot.appendChild(ui.exportMd);
    foot.appendChild(ui.exportJson);
    foot.appendChild(ui.importBtn);
    foot.appendChild(ui.importInput);
    foot.appendChild(ui.footNote);
    ui.panel.appendChild(head);
    ui.panel.appendChild(tabs);
    ui.panel.appendChild(ui.panelNotice);
    ui.panel.appendChild(ui.list);
    ui.panel.appendChild(foot);

    ui.root.appendChild(ui.live);
    ui.root.appendChild(ui.hint);
    document.body.appendChild(ui.root);
    document.body.appendChild(ui.toolbar);
    document.body.appendChild(ui.editor);
    document.body.appendChild(ui.launcher);
    document.body.appendChild(ui.panel);
    bindUi();
  }

  function bindUi() {
    function keepSelection(event) {
      event.preventDefault();
    }
    ui.toolbar.addEventListener('mousedown', keepSelection);
    ui.toolbar.addEventListener('click', function (event) {
      var target = event.target.closest('button');
      if (!target) return;
      if (target.getAttribute('data-note')) createFromPending(COLORS[0], true);
      else createFromPending(target.getAttribute('data-color'), false);
    });

    ui.editor.addEventListener('click', function (event) {
      var target = event.target.closest('button[data-color]');
      if (!target || !state.editor) return;
      saveEditor({ color: target.getAttribute('data-color') }, false);
    });
    ui.editorSave.addEventListener('click', function () {
      saveEditor({ note: ui.editorNote.value }, true);
    });
    ui.editorDelete.addEventListener('click', deleteFromEditor);
    ui.editorClose.addEventListener('click', function () { closeEditor(true); });
    ui.editorNote.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        saveEditor({ note: ui.editorNote.value }, true);
      }
    });

    ui.launcher.addEventListener('click', function () {
      if (ui.panel.hidden) openPanel();
      else closePanel(true);
    });
    ui.panelClose.addEventListener('click', function () { closePanel(true); });
    ui.tabPage.addEventListener('click', function () { setTab('page'); });
    ui.tabAll.addEventListener('click', function () { setTab('all'); });
    [ui.tabPage, ui.tabAll].forEach(function (tab) {
      tab.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        var next = tab === ui.tabPage ? ui.tabAll : ui.tabPage;
        setTab(next.getAttribute('data-tab'));
        next.focus();
      });
    });
    ui.list.addEventListener('click', onListClick);
    ui.exportMd.addEventListener('click', function () { exportScope('md'); });
    ui.exportJson.addEventListener('click', function () { exportScope('json'); });
    ui.importBtn.addEventListener('click', function () { ui.importInput.click(); });
    ui.importInput.addEventListener('change', onImport);
  }

  function bindDocument() {
    if (state.bound) return;
    state.bound = true;

    document.addEventListener('pointerup', function (event) {
      if (event.target && event.target.closest && event.target.closest('.aifs-hl-ui')) return;
      scheduleSelection(10);
    });
    document.addEventListener('keyup', function (event) {
      if (event.shiftKey || event.key === 'Shift' || /^Arrow/.test(event.key)) scheduleSelection(10);
    });
    document.addEventListener('selectionchange', function () {
      var selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        window.clearTimeout(state.selectionTimer);
        state.selectionTimer = window.setTimeout(function () {
          if (!toolbarFocused() && !selectionInfo()) hideToolbar();
        }, 300);
        return;
      }
      scheduleSelection(coarsePointer() ? 350 : 250);
    });
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('pointerdown', function (event) {
      if (!state.editor || ui.editor.hidden) return;
      var target = event.target;
      if (target.closest && (target.closest('.aifs-hl-editor') || target.closest('.aifs-hl') || target.closest('.aifs-hl-atom') || target.closest('.aifs-hl-panel'))) return;
      closeEditor(false);
    });
    window.addEventListener('resize', function () {
      hideToolbar();
      if (state.editor) positionEditor();
    });
    Store.onChange(function (_, meta) {
      if (state.painting || !state.article) return;
      paint(!(meta && meta.external));
      renderPanel();
    });
  }

  function toolbarFocused() {
    return !!(ui.toolbar && ui.toolbar.contains(document.activeElement));
  }

  function scheduleSelection(delay) {
    window.clearTimeout(state.selectionTimer);
    state.selectionTimer = window.setTimeout(updateToolbar, delay);
  }

  function selectionInfo() {
    if (!state.article || !state.article.isConnected) return null;
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    var range = selection.getRangeAt(0);
    var common = range.commonAncestorContainer;
    if (!state.article.contains(common.nodeType === 3 ? common.parentNode : common)) return null;
    var model = Anchor.buildModel(state.article);
    var rawStart = -1;
    var rawEnd = -1;
    for (var i = 0; i < model.segments.length; i++) {
      var segment = model.segments[i];
      if (!segment.node) continue;
      var hits = false;
      try { hits = range.intersectsNode(segment.node); } catch (_) { hits = false; }
      if (!hits) continue;
      var from = segment.start;
      var to = segment.end;
      if (!segment.atomic) {
        if (segment.node === range.startContainer) from = segment.start + range.startOffset;
        if (segment.node === range.endContainer) to = segment.start + range.endOffset;
      }
      if (to <= from) continue;
      if (rawStart < 0) rawStart = from;
      rawEnd = to;
    }
    if (rawStart < 0) return null;
    var span = Anchor.rawToNormalized(model.normalized, rawStart, rawEnd);
    if (span.end <= span.start) return null;
    return {
      model: model,
      start: span.start,
      end: span.end,
      tooLong: span.end - span.start > MAX_SELECTION,
      rect: range.getBoundingClientRect()
    };
  }

  function updateToolbar() {
    var info = selectionInfo();
    if (!info) {
      if (!toolbarFocused()) hideToolbar();
      return;
    }
    state.pending = info;
    showToolbar(info);
  }

  function showToolbar(info) {
    var readOnly = Store.info().readOnly;
    var buttons = ui.toolbar.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = info.tooLong || readOnly;
    ui.toolbar.setAttribute('aria-label', info.tooLong ? 'Selection is too long to highlight' : 'Highlight the selected text');
    ui.toolbar.title = info.tooLong ? 'Select less text to highlight it (up to ' + MAX_SELECTION + ' characters).' : '';
    ui.toolbar.hidden = false;
    var rect = info.rect;
    var width = ui.toolbar.offsetWidth;
    var height = ui.toolbar.offsetHeight;
    var docWidth = document.documentElement.clientWidth;
    var tts = document.getElementById('ttsFromHere');
    var below = coarsePointer() || rect.top < 120 || (tts && !tts.hidden);
    var top = below ? rect.bottom + window.pageYOffset + 10 : rect.top + window.pageYOffset - height - 10;
    var left = rect.left + window.pageXOffset + rect.width / 2 - width / 2;
    left = Math.max(window.pageXOffset + 8, Math.min(left, window.pageXOffset + docWidth - width - 8));
    ui.toolbar.style.top = Math.round(top) + 'px';
    ui.toolbar.style.left = Math.round(left) + 'px';
  }

  function hideToolbar() {
    if (ui.toolbar) ui.toolbar.hidden = true;
    state.pending = null;
  }

  function clearSelection() {
    var selection = window.getSelection();
    if (selection && selection.removeAllRanges) selection.removeAllRanges();
  }

  function storageMessage() {
    var info = Store.info();
    if (info.readOnly) return 'These highlights were saved by a newer version of this site. They are shown here but cannot be changed.';
    if (info.lastError === 'full') return 'Highlights use their full share of browser storage. Delete or export some before adding more.';
    if (info.lastError === 'quota') return 'Browser storage is full. New highlights last only until you close this tab. Export them to keep a copy.';
    if (!info.persistent) return 'This browser does not allow site storage here, so highlights last only until you close this tab.';
    if (info.lastError === 'unreadable' || info.lastError === 'skipped-invalid') {
      return 'Some saved highlight data could not be read. The original was kept in browser storage under ' + 'aifs:highlights:v1:unreadable.';
    }
    return '';
  }

  function createFromPending(color, withNote) {
    var pending = state.pending;
    if (!pending || pending.tooLong || !state.ctx || COLORS.indexOf(color) < 0) return;
    var described = Anchor.describe(pending.model.text, pending.start, pending.end);
    var section = Anchor.sectionAt(pending.model, pending.start);
    var item = Store.add(state.ctx.path, {
      lang: state.ctx.lang,
      color: color,
      note: '',
      quote: described.quote,
      position: described.position,
      section: section ? section.id : '',
      sectionTitle: section ? section.title : '',
      status: 'anchored'
    }, { title: state.ctx.title });
    clearSelection();
    hideToolbar();
    if (!item) {
      announce(Store.info().readOnly ? 'Highlights cannot be changed in this browser.' : (storageMessage() || 'The highlight could not be saved.'));
      return;
    }
    var message = storageMessage();
    announce(message || 'Highlight saved.');
    if (withNote) openEditor(item.id, true);
    else {
      var mark = firstMark(item.id);
      if (mark) mark.focus({ preventScroll: true });
    }
  }

  function unpaint() {
    if (!state.article) return;
    var marks = state.article.querySelectorAll('mark.aifs-hl');
    for (var i = 0; i < marks.length; i++) Anchor.unwrap(marks[i]);
    var atoms = state.article.querySelectorAll('.aifs-hl-atom');
    for (var j = 0; j < atoms.length; j++) {
      atoms[j].classList.remove('aifs-hl-atom');
      COLORS.forEach(function (color) { atoms[j].classList.remove('aifs-hl-bg-' + color); });
      atoms[j].removeAttribute('data-hl-ids');
      if (atoms[j].hasAttribute('data-hl-focus')) {
        atoms[j].removeAttribute('data-hl-focus');
        atoms[j].removeAttribute('tabindex');
        atoms[j].removeAttribute('aria-describedby');
      }
    }
  }

  function createMark(item) {
    return function (index) {
      var mark = document.createElement('mark');
      mark.className = 'aifs-hl aifs-hl-bg-' + item.color + (item.note ? ' aifs-hl-noted' : '');
      mark.setAttribute('data-hl-id', item.id);
      if (index === 0) {
        mark.id = 'hl-' + item.id;
        mark.tabIndex = 0;
        mark.setAttribute('aria-describedby', 'aifsHlMarkHint');
        if (item.note) mark.title = item.note;
      }
      return mark;
    };
  }

  function textHash(value) {
    var hash = 2166136261;
    for (var i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36) + ':' + value.length;
  }

  function paint(persist) {
    if (!state.article || !state.ctx) return;
    state.painting = true;
    try {
      unpaint();
      var items = currentItems();
      var model = Anchor.buildModel(state.article);
      var hash = textHash(model.text);
      var resolved = [];
      var patches = {};
      var runtime = {};
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (langOf(item) !== state.ctx.lang) {
          runtime[item.id] = { status: 'other-lang' };
          continue;
        }
        var cacheKey = item.id + '|' + item.quote.exact;
        var knownOrphan = state.orphanCache[cacheKey] === hash || (item.status === 'orphaned' && item.orphanHash === hash);
        var section = Anchor.sectionById(model, item.section);
        var hit = knownOrphan ? null : Anchor.locate(model.text, item, { regions: section ? [section] : [] });
        if (!hit) {
          state.orphanCache[cacheKey] = hash;
          runtime[item.id] = { status: 'orphaned' };
          if (item.status !== 'orphaned' || item.orphanHash !== hash) patches[item.id] = { status: 'orphaned', orphanHash: hash };
          continue;
        }
        var status = hit.method === 'fuzzy' || item.status === 'moved' ? 'moved' : 'anchored';
        runtime[item.id] = { status: status, method: hit.method, score: hit.score };
        var described = Anchor.describe(model.text, hit.start, hit.end);
        var nextSection = Anchor.sectionAt(model, hit.start);
        var patch = {};
        if (item.status !== status) patch.status = status;
        if (hit.method !== 'context' || item.position.start !== described.position.start || item.position.length !== described.position.length) {
          patch.quote = described.quote;
          patch.position = described.position;
          if (described.quote.exact !== item.quote.exact && !item.originalExact) patch.originalExact = item.quote.exact;
        }
        if (item.orphanHash) patch.orphanHash = '';
        if (nextSection && nextSection.id !== item.section) {
          patch.section = nextSection.id;
          patch.sectionTitle = nextSection.title;
        }
        if (Object.keys(patch).length) patches[item.id] = patch;
        resolved.push({ item: item, start: hit.start, end: hit.end });
      }
      resolved.sort(function (a, b) { return b.start - a.start || a.end - b.end; });
      var wrappedFrom = Infinity;
      for (var r = 0; r < resolved.length; r++) {
        if (resolved[r].end > wrappedFrom) model = Anchor.buildModel(state.article);
        wrappedFrom = Math.min(wrappedFrom, resolved[r].start);
        var painted = Anchor.wrap(model, resolved[r].start, resolved[r].end, createMark(resolved[r].item));
        if (painted.marks.length) {
          var last = painted.marks[painted.marks.length - 1];
          last.classList.add('aifs-hl-end');
        }
        for (var a = 0; a < painted.atoms.length; a++) {
          var atom = painted.atoms[a];
          atom.classList.add('aifs-hl-atom', 'aifs-hl-bg-' + resolved[r].item.color);
          var ids = (atom.getAttribute('data-hl-ids') || '').split(' ').filter(Boolean);
          ids.push(resolved[r].item.id);
          atom.setAttribute('data-hl-ids', ids.join(' '));
        }
        if (!painted.marks.length && painted.atoms.length && !painted.atoms[0].hasAttribute('tabindex')) {
          painted.atoms[0].tabIndex = 0;
          painted.atoms[0].setAttribute('aria-describedby', 'aifsHlMarkHint');
          painted.atoms[0].setAttribute('data-hl-focus', resolved[r].item.id);
        }
        if (!painted.marks.length && !painted.atoms.length) runtime[resolved[r].item.id] = { status: 'orphaned' };
      }
      state.runtime = runtime;
      if (persist !== false && Object.keys(patches).length && !Store.info().readOnly) Store.updateMany(state.ctx.path, patches, true);
    } finally {
      state.painting = false;
    }
    updateLauncher();
  }

  function firstMark(id) {
    if (!state.article) return null;
    var mark = document.getElementById('hl-' + id);
    if (mark && state.article.contains(mark)) return mark;
    var atoms = state.article.querySelectorAll('.aifs-hl-atom');
    for (var i = 0; i < atoms.length; i++) {
      if ((' ' + atoms[i].getAttribute('data-hl-ids') + ' ').indexOf(' ' + id + ' ') >= 0) return atoms[i];
    }
    return null;
  }

  function idFromTarget(target) {
    if (!target || !target.closest || !state.article || !state.article.contains(target)) return '';
    var mark = target.closest('mark.aifs-hl');
    if (mark) return mark.getAttribute('data-hl-id');
    var atom = target.closest('.aifs-hl-atom');
    if (atom) return (atom.getAttribute('data-hl-ids') || '').split(' ')[0] || '';
    return '';
  }

  function onDocumentClick(event) {
    var id = idFromTarget(event.target);
    if (!id) return;
    var selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    if (event.target.closest('a, button')) return;
    openEditor(id, false);
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      if (state.editor && !ui.editor.hidden) {
        event.preventDefault();
        closeEditor(true);
        return;
      }
      if (ui.toolbar && !ui.toolbar.hidden) {
        event.preventDefault();
        hideToolbar();
        return;
      }
      if (ui.panel && !ui.panel.hidden && ui.panel.contains(document.activeElement)) {
        event.preventDefault();
        closePanel(true);
      }
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.code === 'KeyH' || event.key === 'h' || event.key === 'H')) {
      var info = selectionInfo();
      if (!info) return;
      event.preventDefault();
      state.pending = info;
      showToolbar(info);
      var first = ui.toolbar.querySelector('button:not([disabled])');
      if (first) first.focus();
      return;
    }
    if (event.key === 'Tab' && !event.shiftKey && ui.toolbar && !ui.toolbar.hidden && !toolbarFocused()) {
      var active = document.activeElement;
      if (active && active !== document.body && !(state.article && state.article.contains(active))) return;
      var firstButton = ui.toolbar.querySelector('button:not([disabled])');
      if (!firstButton) return;
      event.preventDefault();
      firstButton.focus();
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && event.target && event.target.matches && event.target.matches('mark.aifs-hl[tabindex], .aifs-hl-atom[data-hl-focus]')) {
      event.preventDefault();
      openEditor(idFromTarget(event.target), false);
    }
  }

  function openEditor(id, focusNote, anchorEl) {
    var item = findItem(id);
    if (!item) return;
    hideToolbar();
    var fromPanel = !!(anchorEl && ui.panel.contains(anchorEl));
    state.editor = { id: id, anchor: anchorEl || null, fromPanel: fromPanel, returnFocus: fromPanel ? null : (anchorEl || firstMark(id)) };
    ui.editorNote.value = item.note || '';
    ui.editorStatus.textContent = '';
    var readOnly = Store.info().readOnly;
    var swatches = ui.editor.querySelectorAll('button[data-color]');
    for (var i = 0; i < swatches.length; i++) {
      swatches[i].setAttribute('aria-pressed', swatches[i].getAttribute('data-color') === item.color ? 'true' : 'false');
      swatches[i].disabled = readOnly;
    }
    ui.editorNote.disabled = readOnly;
    ui.editorSave.disabled = readOnly;
    ui.editorDelete.disabled = readOnly;
    ui.editor.hidden = false;
    positionEditor();
    if (focusNote) ui.editorNote.focus();
    else {
      var pressed = ui.editor.querySelector('button[aria-pressed="true"]');
      (pressed || ui.editorNote).focus();
    }
  }

  function positionEditor() {
    if (!state.editor) return;
    var anchor = state.editor.fromPanel ? null : firstMark(state.editor.id);
    var docWidth = document.documentElement.clientWidth;
    var width = ui.editor.offsetWidth;
    var top;
    var left;
    if (anchor) {
      var rect = anchor.getBoundingClientRect();
      top = rect.bottom + window.pageYOffset + 10;
      left = rect.left + window.pageXOffset;
      ui.editor.classList.remove('aifs-hl-editor-fixed');
    } else {
      ui.editor.classList.add('aifs-hl-editor-fixed');
      ui.editor.style.top = '';
      ui.editor.style.left = '';
      return;
    }
    left = Math.max(window.pageXOffset + 8, Math.min(left, window.pageXOffset + docWidth - width - 8));
    ui.editor.style.top = Math.round(top) + 'px';
    ui.editor.style.left = Math.round(left) + 'px';
  }

  function closeEditor(restoreFocus) {
    if (!state.editor) return;
    var target = state.editor.returnFocus;
    var id = state.editor.id;
    var fromPanel = state.editor.fromPanel;
    state.editor = null;
    ui.editor.hidden = true;
    if (!restoreFocus) return;
    if (fromPanel && !ui.panel.hidden) {
      var row = ui.list.querySelector('.aifs-hl-item[data-hl-id="' + id + '"] button[data-action="edit"]');
      (row || ui.list).focus();
      return;
    }
    if (!target || !target.isConnected) target = firstMark(id);
    if (target && target.focus) target.focus({ preventScroll: true });
  }

  function saveEditor(patch, closeAfter) {
    if (!state.editor || !state.ctx) return;
    var id = state.editor.id;
    var updated = Store.update(state.ctx.path, id, patch);
    if (!updated) {
      ui.editorStatus.textContent = 'The change could not be saved.';
      return;
    }
    var swatches = ui.editor.querySelectorAll('button[data-color]');
    for (var i = 0; i < swatches.length; i++) {
      swatches[i].setAttribute('aria-pressed', swatches[i].getAttribute('data-color') === updated.color ? 'true' : 'false');
    }
    var message = storageMessage();
    announce(message || (patch.color ? 'Colour changed to ' + COLOR_LABELS[updated.color].toLowerCase() + '.' : 'Note saved.'));
    if (closeAfter) closeEditor(true);
    else positionEditor();
  }

  function deleteFromEditor() {
    if (!state.editor || !state.ctx) return;
    var id = state.editor.id;
    var fromPanel = state.editor.fromPanel;
    state.editor = null;
    ui.editor.hidden = true;
    if (Store.remove(state.ctx.path, id)) announce('Highlight deleted.');
    if (fromPanel && !ui.panel.hidden) ui.list.focus();
    else ui.launcher.focus();
  }

  function updateLauncher() {
    if (!ui.launcher || !state.ctx) return;
    var count = currentItems().length;
    ui.launcherCount.textContent = count ? String(count) : '';
    ui.launcherCount.hidden = !count;
    ui.launcher.setAttribute('aria-label', count ? 'My highlights, ' + count + ' on this page' : 'My highlights');
  }

  function openPanel() {
    ui.panel.hidden = false;
    ui.launcher.setAttribute('aria-expanded', 'true');
    document.documentElement.classList.add('aifs-hl-panel-open');
    renderPanel();
    ui.panelClose.focus();
  }

  function closePanel(restoreFocus) {
    if (!ui.panel || ui.panel.hidden) return;
    ui.panel.hidden = true;
    ui.launcher.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('aifs-hl-panel-open');
    if (state.editor && state.editor.fromPanel) closeEditor(false);
    if (restoreFocus) ui.launcher.focus();
  }

  function setTab(tab) {
    state.tab = tab === 'all' ? 'all' : 'page';
    renderPanel();
  }

  function statusBadge(status, lang) {
    if (status === 'orphaned') return { cls: 'aifs-hl-badge-orphan', text: 'Orphaned', help: 'The lesson text changed and this passage was not found. The highlight is kept so you can read it, export it or delete it.' };
    if (status === 'moved') return { cls: 'aifs-hl-badge-moved', text: 'Re-anchored', help: 'The lesson text changed. The highlight now marks the closest match.' };
    if (status === 'other-lang') return { cls: 'aifs-hl-badge-lang', text: 'Saved in ' + lang, help: 'Switch the lesson language to ' + lang + ' to see this highlight in place.' };
    return null;
  }

  function itemNode(item, status, scope, path) {
    var li = make('li', 'aifs-hl-item', { 'data-hl-id': item.id, 'data-path': path });
    var swatch = make('span', 'aifs-hl-item-swatch aifs-hl-bg-' + item.color, { 'aria-hidden': 'true' });
    var body = make('div', 'aifs-hl-item-body');
    var quote = make('blockquote', 'aifs-hl-item-quote');
    quote.textContent = preview(item.quote.exact);
    body.appendChild(quote);
    if (item.originalExact && item.originalExact !== item.quote.exact) {
      var original = make('p', 'aifs-hl-item-note aifs-hl-item-original');
      original.textContent = 'Originally: ' + preview(item.originalExact);
      body.appendChild(original);
    }
    if (item.note) {
      var note = make('p', 'aifs-hl-item-note');
      note.textContent = item.note;
      body.appendChild(note);
    }
    var meta = make('p', 'aifs-hl-item-meta');
    if (item.sectionTitle) {
      var section = make('span', 'aifs-hl-item-section');
      section.textContent = item.sectionTitle;
      meta.appendChild(section);
    }
    var badge = statusBadge(status, langOf(item));
    if (badge) {
      var tag = make('span', 'aifs-hl-badge ' + badge.cls, { title: badge.help });
      tag.textContent = badge.text;
      meta.appendChild(tag);
      if (status === 'orphaned' && scope === 'page') {
        var help = make('span', 'aifs-hl-item-help');
        help.textContent = badge.help;
        meta.appendChild(help);
      }
    }
    if (meta.childNodes.length) body.appendChild(meta);
    var actions = make('div', 'aifs-hl-item-actions');
    if (scope === 'page') {
      if (status === 'anchored' || status === 'moved') actions.appendChild(button('aifs-hl-link', 'Jump to text', { 'data-action': 'jump' }));
      else if (status === 'orphaned' && item.section && document.getElementById(item.section)) {
        actions.appendChild(button('aifs-hl-link', 'Go to section', { 'data-action': 'section' }));
      }
      if (status !== 'other-lang') actions.appendChild(button('aifs-hl-link', item.note ? 'Edit note' : 'Add note', { 'data-action': 'edit' }));
      actions.appendChild(button('aifs-hl-link aifs-hl-link-danger', 'Delete', { 'data-action': 'delete' }));
    } else {
      var open = make('a', 'aifs-hl-link', { href: lessonHref(path, item.id) });
      open.textContent = 'Open';
      actions.appendChild(open);
    }
    body.appendChild(actions);
    li.appendChild(swatch);
    li.appendChild(body);
    return li;
  }

  function renderPanel() {
    if (!ui.panel || ui.panel.hidden || !state.ctx) return;
    var pageItems = currentItems();
    var all = Store.pages();
    var total = 0;
    for (var p = 0; p < all.length; p++) total += all[p].items.length;
    ui.tabPage.textContent = 'This page (' + pageItems.length + ')';
    ui.tabAll.textContent = 'All pages (' + total + ')';
    ui.tabPage.setAttribute('aria-selected', state.tab === 'page' ? 'true' : 'false');
    ui.tabAll.setAttribute('aria-selected', state.tab === 'all' ? 'true' : 'false');
    ui.tabPage.tabIndex = state.tab === 'page' ? 0 : -1;
    ui.tabAll.tabIndex = state.tab === 'all' ? 0 : -1;
    ui.list.setAttribute('aria-labelledby', state.tab === 'page' ? 'aifsHlTabPage' : 'aifsHlTabAll');
    var message = storageMessage();
    ui.panelNotice.hidden = !message;
    ui.panelNotice.textContent = message;
    ui.importBtn.disabled = Store.info().readOnly;
    ui.list.textContent = '';

    if (state.tab === 'page') {
      if (!pageItems.length) {
        var empty = make('p', 'aifs-hl-empty');
        empty.textContent = 'Select text in the lesson to highlight it. On a keyboard, select with Shift and the arrow keys, then press Alt+H.';
        ui.list.appendChild(empty);
      } else {
        var orphans = 0;
        var list = make('ul', 'aifs-hl-items');
        pageItems.forEach(function (item) {
          var status = state.runtime[item.id] ? state.runtime[item.id].status : item.status;
          if (status === 'orphaned') orphans++;
          list.appendChild(itemNode(item, status, 'page', state.ctx.path));
        });
        if (orphans) {
          var summary = make('p', 'aifs-hl-orphan-summary');
          summary.textContent = orphans + (orphans === 1 ? ' highlight is' : ' highlights are') + ' orphaned. The lesson changed and the text was not found. Nothing was deleted.';
          ui.list.appendChild(summary);
        }
        ui.list.appendChild(list);
      }
    } else if (!all.length) {
      var none = make('p', 'aifs-hl-empty');
      none.textContent = 'No highlights in this browser yet.';
      ui.list.appendChild(none);
    } else {
      all.forEach(function (page) {
        var group = make('section', 'aifs-hl-group');
        var heading = make('h3', 'aifs-hl-group-title');
        var link = make('a', '', { href: lessonHref(page.path, '') });
        link.textContent = page.title || page.path;
        heading.appendChild(link);
        var count = make('span', 'aifs-hl-group-count');
        count.textContent = page.items.length + (page.items.length === 1 ? ' highlight' : ' highlights');
        heading.appendChild(count);
        group.appendChild(heading);
        var items = make('ul', 'aifs-hl-items');
        page.items.forEach(function (item) {
          var status = page.path === state.ctx.path && state.runtime[item.id] ? state.runtime[item.id].status : item.status;
          items.appendChild(itemNode(item, status, 'all', page.path));
        });
        group.appendChild(items);
        ui.list.appendChild(group);
      });
    }
  }

  function revealDetails(node) {
    var parent = node.parentNode;
    while (parent && parent !== state.article) {
      if (parent.tagName === 'DETAILS' && !parent.open) parent.open = true;
      parent = parent.parentNode;
    }
  }

  function jumpTo(target) {
    if (!target) return;
    revealDetails(target);
    if (coarsePointer() || window.innerWidth < 720) closePanel(false);
    target.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
    if (target.focus) {
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }
    var id = target.getAttribute('data-hl-id') || '';
    var marks = id ? state.article.querySelectorAll('mark.aifs-hl[data-hl-id="' + id + '"]') : [target];
    for (var i = 0; i < marks.length; i++) {
      marks[i].classList.remove('aifs-hl-flash');
      void marks[i].offsetWidth;
      marks[i].classList.add('aifs-hl-flash');
    }
  }

  function onListClick(event) {
    var actionButton = event.target.closest('button[data-action]');
    if (!actionButton) return;
    var li = actionButton.closest('.aifs-hl-item');
    var id = li && li.getAttribute('data-hl-id');
    if (!id || !state.ctx) return;
    var action = actionButton.getAttribute('data-action');
    if (action === 'jump') jumpTo(firstMark(id));
    else if (action === 'section') {
      var item = findItem(id);
      if (item) jumpTo(document.getElementById(item.section));
    } else if (action === 'edit') {
      var mark = firstMark(id);
      if (mark && !(coarsePointer() || window.innerWidth < 720)) openEditor(id, true, mark);
      else openEditor(id, true, li);
    } else if (action === 'delete') {
      if (Store.remove(state.ctx.path, id)) announce('Highlight deleted.');
      ui.list.focus();
    }
  }

  function slug(value) {
    return String(value || 'lesson').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'lesson';
  }

  function download(filename, type, content) {
    var blob = new Blob([content], { type: type });
    var url = URL.createObjectURL(blob);
    var link = make('a', '', { href: url, download: filename });
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
      link.remove();
    }, 1000);
  }

  function exportScope(kind) {
    if (!state.ctx) return;
    var paths = state.tab === 'page' ? [state.ctx.path] : null;
    var date = new Date().toISOString().slice(0, 10);
    var name = 'highlights-' + (state.tab === 'page' ? slug(state.ctx.path.split('/').pop()) : 'all') + '-' + date;
    var origin = window.location.origin && /^https?:/.test(window.location.origin) ? window.location.origin : 'https://aiengineeringfromscratch.com';
    if (kind === 'md') download(name + '.md', 'text/markdown', Store.exportMarkdown(paths, { baseUrl: origin + '/lesson?path=' }));
    else download(name + '.json', 'application/json', Store.exportJson(paths));
    announce(kind === 'md' ? 'Markdown export ready.' : 'JSON export ready.');
  }

  function onImport() {
    var file = ui.importInput.files && ui.importInput.files[0];
    ui.importInput.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      announce('That file is larger than 5 MB and was not imported.');
      showNotice('That file is larger than 5 MB and was not imported.');
      return;
    }
    file.text().then(function (content) {
      var result = Store.importJson(content);
      var message;
      if (!result.ok) {
        if (result.error === 'newer-schema') message = 'That file comes from a newer version of this site, or this browser holds newer highlights, so nothing was imported.';
        else if (result.error === 'too-large') message = 'Importing that file would use too much browser storage, so nothing was imported.';
        else message = 'That file is not a highlights export and was not imported.';
      } else {
        message = 'Imported ' + result.added + ' new, updated ' + result.updated + ', kept ' + result.unchanged + ' unchanged' + (result.skipped ? ', skipped ' + result.skipped + ' invalid' : '') + '.';
      }
      renderPanel();
      showNotice(message);
      announce(message);
    }).catch(function () {
      showNotice('The file could not be read.');
    });
  }

  function showNotice(message) {
    ui.panelNotice.hidden = false;
    ui.panelNotice.textContent = message;
  }

  function normalizeLang(value) {
    var lang = String(value || 'en').toLowerCase();
    return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(lang) ? lang : 'en';
  }

  function mount(article, ctx) {
    unmount();
    if (!article || !ctx || !ctx.path) return;
    ensureUi();
    bindDocument();
    state.article = article;
    state.ctx = { path: String(ctx.path), lang: normalizeLang(ctx.lang), title: String(ctx.title || '') };
    state.runtime = {};
    ui.launcher.hidden = false;
    paint();
    renderPanel();
  }

  function unmount() {
    hideToolbar();
    if (state.editor) closeEditor(false);
    if (state.article) unpaint();
    state.article = null;
    state.ctx = null;
    state.runtime = {};
    if (ui.launcher) ui.launcher.hidden = true;
    if (ui.panel && !ui.panel.hidden) closePanel(false);
  }

  window.AIFSHighlights = {
    mount: mount,
    unmount: unmount,
    refresh: function () {
      if (!state.article) return;
      paint();
      renderPanel();
    },
    status: function () {
      var copy = {};
      for (var id in state.runtime) {
        if (Object.prototype.hasOwnProperty.call(state.runtime, id)) copy[id] = state.runtime[id].status;
      }
      return copy;
    }
  };
}());
