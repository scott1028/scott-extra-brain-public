import { decryptPage } from './crypto.js';
import { getRoute, getRouteHash, loadIndex, takeApiKey } from './reader.js';
import { getHighlightedHtml, searchNotes } from './search.js';

let notes = [];
let notesByStem = new Map();
let keys = null;

const searchInput = document.querySelector('#search-input');
const searchResults = document.querySelector('#search-results');
const menuButton = document.querySelector('.menu-button');
const sidebarResizer = document.querySelector('.sidebar-resizer');
const mobileQuery = matchMedia('(max-width: 760px)');

let currentResults = [];
let activeIndex = -1;
let renderSeq = 0;

const renderSidebar = () => {
  const list = document.createElement('ul');
  for (const note of notes) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = getRouteHash({ stem: note.stem });
    link.dataset.stem = note.stem;
    link.title = note.title;
    const title = document.createElement('span');
    title.className = 'item-title';
    title.textContent = note.title;
    link.append(title);
    item.append(link);
    list.append(item);
  }
  document.querySelector('#sidebar').replaceChildren(list);
};

const buildNoteHeader = (note) => {
  const header = document.createElement('header');
  header.className = 'note-header markdown-body';
  const title = document.createElement('h1');
  title.textContent = note.title;
  const meta = document.createElement('p');
  meta.className = 'note-meta';
  meta.textContent = note.date;
  header.append(title, meta);
  if (note.summary) {
    const summary = document.createElement('p');
    summary.className = 'note-summary';
    summary.textContent = note.summary;
    header.append(summary);
  }
  if (note.keywords?.length > 0) {
    const keywords = document.createElement('div');
    keywords.className = 'note-keywords';
    for (const keyword of note.keywords) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'keyword';
      button.textContent = keyword;
      button.addEventListener('click', () => {
        searchInput.value = keyword;
        searchInput.focus();
        renderSearchResults();
      });
      keywords.append(button);
    }
    header.append(keywords);
  }
  return header;
};

const postProcessArticle = (article) => {
  if (article.firstElementChild?.tagName === 'H1') article.firstElementChild.remove();
  article.querySelectorAll('h2, h3').forEach((heading, index) => {
    heading.id = `heading-${index}`;
  });
  for (const link of article.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href') ?? '';
    const markdownLink = href.match(/^(?:\.\/)?([^/#?]+)\.md$/);
    if (markdownLink) {
      const stem = decodeURIComponent(markdownLink[1]);
      if (notesByStem.has(stem)) link.href = getRouteHash({ stem });
    } else if (href.startsWith('http://') || href.startsWith('https://')) {
      link.target = '_blank';
      link.rel = 'noopener';
    }
  }
  for (const block of article.querySelectorAll('pre code[class*="language-"]')) {
    const language = [...block.classList].find((name) => name.startsWith('language-'))?.slice('language-'.length);
    if (language && hljs.getLanguage(language)) hljs.highlightElement(block);
  }
};

const renderToc = (article) => {
  const toc = document.querySelector('#toc');
  const headings = [...article.querySelectorAll('h2, h3')];
  if (headings.length < 2) {
    toc.replaceChildren();
    toc.hidden = true;
    return;
  }
  toc.hidden = false;
  const title = document.createElement('p');
  title.className = 'toc-title';
  title.textContent = '本頁目錄';
  const list = document.createElement('ul');
  for (const heading of headings) {
    const item = document.createElement('li');
    item.className = heading.tagName === 'H2' ? 'toc-h2' : 'toc-h3';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = heading.textContent;
    button.addEventListener('click', () => heading.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    item.append(button);
    list.append(item);
  }
  toc.replaceChildren(title, list);
};

const renderNote = async (note) => {
  const seq = ++renderSeq;
  for (const link of document.querySelectorAll('#sidebar a')) {
    link.classList.toggle('is-active', link.dataset.stem === note.stem);
  }
  const activeLink = document.querySelector(`#sidebar a[data-stem="${CSS.escape(note.stem)}"]`);
  if (activeLink) {
    activeLink.scrollIntoView({ block: 'nearest' });
  }
  document.title = `${note.title} · Scott Extra Brain`;
  document.body.classList.remove('is-sidebar-open');
  window.scrollTo(0, 0);

  const content = document.querySelector('#content');
  let markdown;
  try {
    const bytes = await (await fetch(`p/${note.id}.bin`)).arrayBuffer();
    markdown = await decryptPage({ id: note.id, bytes, keys });
  } catch {
    if (seq !== renderSeq) return;
    const status = document.createElement('p');
    status.className = 'status';
    status.textContent = `讀取失敗：${note.title}`;
    content.replaceChildren(status);
    return;
  }
  if (seq !== renderSeq) return;
  markdown = markdown.replace(/^\uFEFF/, '');

  const article = document.createElement('article');
  article.className = 'markdown-body';
  article.innerHTML = DOMPurify.sanitize(marked.parse(markdown));
  postProcessArticle(article);
  content.replaceChildren(buildNoteHeader(note), article);
  renderToc(article);
};

const route = () => {
  const stem = getRoute(location.hash).stem;
  let note = notesByStem.get(stem);
  if (!note) {
    note = notes[0];
    history.replaceState(null, '', getRouteHash({ stem: note.stem }));
  }
  renderNote(note);
};

const closeSearch = () => {
  searchResults.hidden = true;
  searchResults.replaceChildren();
  searchInput.value = '';
  currentResults = [];
  activeIndex = -1;
};

const renderSearchResults = () => {
  const query = searchInput.value;
  currentResults = searchNotes(notes, query);
  activeIndex = -1;
  if (!query) {
    searchResults.hidden = true;
    searchResults.replaceChildren();
    return;
  }
  searchResults.hidden = false;
  if (currentResults.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '找不到符合的筆記';
    searchResults.replaceChildren(empty);
    return;
  }
  const items = currentResults.map(({ note }) => {
    const item = document.createElement('li');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', 'false');
    const link = document.createElement('a');
    link.href = getRouteHash({ stem: note.stem });
    const title = document.createElement('span');
    title.className = 'result-title';
    title.innerHTML = getHighlightedHtml(note.title, query);
    link.append(title);
    if (note.summary) {
      const summary = document.createElement('span');
      summary.className = 'result-summary';
      summary.innerHTML = getHighlightedHtml(note.summary, query);
      link.append(summary);
    }
    if (note.keywords?.length > 0) {
      const keywords = document.createElement('span');
      keywords.className = 'result-keywords';
      keywords.innerHTML = getHighlightedHtml(note.keywords.join(' · '), query);
      link.append(keywords);
    }
    item.append(link);
    return item;
  });
  searchResults.replaceChildren(...items);
};

const setActiveResult = (index) => {
  const items = [...searchResults.querySelectorAll('li[role="option"]')];
  if (items.length === 0) return;
  activeIndex = (index + items.length) % items.length;
  items.forEach((item, i) => {
    const isCurrent = i === activeIndex;
    item.classList.toggle('is-active', isCurrent);
    item.setAttribute('aria-selected', String(isCurrent));
  });
};

searchInput.addEventListener('input', renderSearchResults);

searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    setActiveResult(activeIndex + 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    setActiveResult(activeIndex - 1);
  } else if (event.key === 'Enter') {
    const target = currentResults[activeIndex] ?? currentResults[0];
    if (target) {
      location.hash = getRouteHash({ stem: target.note.stem });
      closeSearch();
    }
  } else if (event.key === 'Escape') {
    closeSearch();
    searchInput.blur();
  }
});

// hash may not change when the same note is already open, so close the dropdown here too
searchResults.addEventListener('click', (event) => {
  if (event.target.closest('a')) setTimeout(closeSearch);
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.search') && !event.target.closest('.keyword')) closeSearch();
});

document.addEventListener('keydown', (event) => {
  const isTextTarget = event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(event.target.tagName);
  if ((event.key === '/' && !isTextTarget) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k')) {
    event.preventDefault();
    searchInput.focus();
  }
});

// Desktop collapses the sidebar column; mobile opens the off-canvas drawer
menuButton.setAttribute('aria-expanded', String(!mobileQuery.matches));
menuButton.addEventListener('click', () => {
  const isMobile = mobileQuery.matches;
  const isToggled = document.body.classList.toggle(isMobile ? 'is-sidebar-open' : 'is-sidebar-collapsed');
  menuButton.setAttribute('aria-expanded', String(isMobile ? isToggled : !isToggled));
});

sidebarResizer.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  sidebarResizer.setPointerCapture(event.pointerId);
  document.body.classList.add('is-resizing');
});

sidebarResizer.addEventListener('pointermove', (event) => {
  if (!sidebarResizer.hasPointerCapture(event.pointerId)) return;
  const width = Math.min(Math.max(event.clientX, 200), window.innerWidth * 0.6);
  document.documentElement.style.setProperty('--sidebar-width', `${Math.round(width)}px`);
});

sidebarResizer.addEventListener('lostpointercapture', () => {
  document.body.classList.remove('is-resizing');
});

// Reading the sessionStorage property itself can throw in some browsers
const getStorage = () => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

const fetchBytes = async (path) => (await fetch(path)).arrayBuffer();

const init = async () => {
  window.addEventListener('hashchange', () => {
    if (getRoute(location.hash).apiKey) {
      location.reload(); // pasted key URL: store and strip the key from scratch
      return;
    }
    if (!keys) return; // locked: routing stays off
    closeSearch();
    route();
  });
  const storage = getStorage();
  const isKeyInHash = Boolean(getRoute(location.hash).apiKey);
  const { apiKey, cleanHash } = takeApiKey(location.hash, storage);
  if (isKeyInHash) history.replaceState(null, '', cleanHash);
  try {
    const result = await loadIndex(apiKey, fetchBytes);
    keys = result.keys;
    notes = result.notes;
  } catch {
    try {
      storage?.removeItem('api-key');
    } catch {}
    const status = document.createElement('p');
    status.className = 'status';
    status.textContent = '需要有效的 api-key 才能閱讀';
    document.querySelector('#content').replaceChildren(status);
    searchInput.disabled = true;
    return;
  }
  notesByStem = new Map(notes.map((note) => [note.stem, note]));
  renderSidebar();
  route();
};

init();
