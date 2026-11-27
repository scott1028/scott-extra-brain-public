export const normalizeText = (text) => String(text ?? '').normalize('NFKC').toLowerCase();

export const getSearchTerms = (query) => normalizeText(query).split(/\s+/).filter(Boolean);

export const searchNotes = (notes, query, limit = 20) => {
  const terms = getSearchTerms(query);
  if (terms.length === 0) return [];
  const scored = [];
  for (const note of notes) {
    const title = normalizeText(note.title);
    const summary = normalizeText(note.summary);
    const stem = normalizeText(note.stem);
    const keywords = (note.keywords ?? []).map(normalizeText);
    let score = 0;
    let matched = true;
    for (const term of terms) {
      let termScore = 0;
      if (title.includes(term)) termScore += 10;
      if (keywords.includes(term)) termScore += 8;
      else if (keywords.some((keyword) => keyword.includes(term))) termScore += 5;
      if (summary.includes(term)) termScore += 2;
      if (stem.includes(term)) termScore += 1;
      if (termScore === 0) {
        matched = false;
        break;
      }
      score += termScore;
    }
    if (matched) scored.push({ note, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.note.date < b.note.date ? 1 : a.note.date > b.note.date ? -1 : 0));
  return scored.slice(0, limit);
};

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export const getHighlightedHtml = (text, query) => {
  const source = String(text ?? '');
  const terms = getSearchTerms(query);
  if (terms.length === 0) return escapeHtml(source);
  const pattern = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const parts = [];
  let lastIndex = 0;
  for (const match of source.matchAll(new RegExp(pattern, 'giu'))) {
    parts.push(escapeHtml(source.slice(lastIndex, match.index)), `<mark>${escapeHtml(match[0])}</mark>`);
    lastIndex = match.index + match[0].length;
  }
  parts.push(escapeHtml(source.slice(lastIndex)));
  return parts.join('');
};
