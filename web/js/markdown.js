// A deliberately small, escape-first Markdown renderer for model output.
// Raw HTML from the model is never injected: every input line is escaped first,
// then a narrow set of inline constructs is turned into DOM nodes.

const INLINE_CITATION = /\[(\d{1,2})\]/g;

export function renderMarkdown(markdown) {
  const root = document.createElement('div');
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  let paragraph = [];
  let list = null;
  let code = null;
  let quote = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = document.createElement('p');
    appendInline(p, paragraph.join(' '));
    root.appendChild(p);
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    root.appendChild(list);
    list = null;
  };

  const flushQuote = () => {
    if (!quote.length) return;
    const blockquote = document.createElement('blockquote');
    const p = document.createElement('p');
    appendInline(p, quote.join(' '));
    blockquote.appendChild(p);
    root.appendChild(blockquote);
    quote = [];
  };

  const flushCode = () => {
    if (!code) return;
    const pre = document.createElement('pre');
    const codeEl = document.createElement('code');
    codeEl.textContent = code.lines.join('\n');
    pre.appendChild(codeEl);
    root.appendChild(pre);
    code = null;
  };

  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
    flushCode();
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.trim().startsWith('```')) {
      if (code) {
        flushCode();
      } else {
        flushAll();
        code = { lines: [] };
      }
      continue;
    }
    if (code) {
      code.lines.push(rawLine);
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      const el = document.createElement(`h${level}`);
      appendInline(el, heading[2]);
      root.appendChild(el);
      continue;
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushAll();
      root.appendChild(document.createElement('hr'));
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      flushList();
      quote.push(line.replace(/^\s*>\s?/, ''));
      continue;
    }
    flushQuote();

    const ordered = /^\s*(\d{1,2})[.)]\s+(.+)$/.exec(line);
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (ordered || unordered) {
      flushParagraph();
      const kind = ordered ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== kind) {
        flushList();
        list = document.createElement(kind);
      }
      const li = document.createElement('li');
      appendInline(li, ordered ? ordered[2] : unordered[1]);
      list.appendChild(li);
      continue;
    }
    flushList();

    paragraph.push(line.trim());
  }
  flushAll();
  return root;
}

function appendInline(parent, text) {
  const escaped = String(text);
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\)|\[(\d{1,2})\])/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(escaped)) !== null) {
    if (match.index > lastIndex) {
      parent.appendChild(document.createTextNode(escaped.slice(lastIndex, match.index)));
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.appendChild(code);
    } else if ((token.startsWith('**') && token.endsWith('**')) || (token.startsWith('__') && token.endsWith('__'))) {
      const strong = document.createElement('strong');
      appendInline(strong, token.slice(2, -2));
      parent.appendChild(strong);
    } else if ((token.startsWith('*') && token.endsWith('*')) || (token.startsWith('_') && token.endsWith('_'))) {
      const em = document.createElement('em');
      appendInline(em, token.slice(1, -1));
      parent.appendChild(em);
    } else if (token.startsWith('[') && token.includes('](') && token.endsWith(')')) {
      const close = token.indexOf('](');
      const label = token.slice(1, close);
      const href = token.slice(close + 2, -1).trim();
      appendLink(parent, label, href);
    } else if (/^\[\d{1,2}\]$/.test(token)) {
      const citation = document.createElement('span');
      citation.className = 'citation';
      citation.textContent = token.slice(1, -1);
      parent.appendChild(citation);
    } else {
      parent.appendChild(document.createTextNode(token));
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < escaped.length) {
    parent.appendChild(document.createTextNode(escaped.slice(lastIndex)));
  }
}

function appendLink(parent, label, href) {
  let parsed;
  try {
    parsed = new URL(href, window.location.origin);
  } catch {
    parent.appendChild(document.createTextNode(label));
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    parent.appendChild(document.createTextNode(label));
    return;
  }
  const a = document.createElement('a');
  a.href = parsed.href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  appendInline(a, label);
  parent.appendChild(a);
}

export function plainText(markdown) {
  const node = renderMarkdown(markdown);
  node.querySelectorAll('.citation').forEach((citation) => {
    citation.textContent = `[${citation.textContent}]`;
  });
  return node.textContent.replace(/\s+/g, ' ').trim();
}
