import { safeArtwork } from './artwork.js';
const $ = (id) => document.getElementById(id);
const names = { rutube: 'Rutube', yummy: 'YummyAnime', lordfilm: 'LordFilm' };
export function createSourceSearch({ request, add }) {
  let sequence = 0;
  const reset = () => {
    sequence++;
    $('searchStatus').textContent = '';
    $('searchResults').replaceChildren();
    $('searchSubmit').disabled = false;
  };
  $('catalogSearchQuery').addEventListener('input', reset);
  $('catalogSearchProvider').addEventListener('change', reset);
  $('addDialog').addEventListener('close', reset);
  $('catalogSearchForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const seq = ++sequence,
      query = $('catalogSearchQuery').value.trim(),
      provider = $('catalogSearchProvider').value;
    if (query.length < 2) return;
    $('searchSubmit').disabled = true;
    $('searchStatus').textContent = 'Ищем на выбранных сайтах…';
    $('searchResults').replaceChildren();
    const external = $('externalSearchLinks');
    external.replaceChildren();
    for (const [name, url] of [
      [
        'YouTube',
        `https://www.youtube.com/results?${new URLSearchParams({ search_query: query })}`,
      ],
      ['Vimeo', `https://vimeo.com/search?${new URLSearchParams({ q: query })}`],
      ['Twitch', `https://www.twitch.tv/search?${new URLSearchParams({ term: query })}`],
    ]) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = `Поиск ${name} ↗`;
      external.append(a);
    }
    try {
      const result = await request({
        query,
        providers: provider === 'all' ? ['rutube', 'yummy', 'lordfilm'] : [provider],
      });
      if (seq !== sequence) return;
      const unavailable = result.sources
        .filter((source) => !source.available)
        .map((source) => names[source.provider]);
      $('searchStatus').textContent =
        `Найдено: ${result.results.length}.${unavailable.length ? ` Не ответили: ${unavailable.join(', ')}.` : ''} Доступность видео проверяется при просмотре.`;
      for (const item of result.results) {
        const row = document.createElement('article');
        row.className = 'search-result';
        const art = document.createElement('div');
        art.className = 'search-result-art';
        art.textContent = item.title.slice(0, 1).toUpperCase();
        const poster = safeArtwork(item.poster);
        if (poster) {
          const img = document.createElement('img');
          img.src = poster;
          img.alt = '';
          img.loading = 'lazy';
          img.referrerPolicy = 'no-referrer';
          img.onerror = () => img.remove();
          art.append(img);
        }
        const content = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = item.title;
        const detail = document.createElement('small');
        detail.textContent = [names[item.provider], item.detail].filter(Boolean).join(' · ');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'small-button';
        button.textContent = 'В очередь';
        button.setAttribute('aria-label', `Добавить: ${item.title}`);
        button.onclick = async () => {
          button.disabled = true;
          try {
            await add(item.url);
          } catch (error) {
            $('searchStatus').textContent = error.message;
          } finally {
            button.disabled = false;
          }
        };
        content.append(title, detail, button);
        row.append(art, content);
        $('searchResults').append(row);
      }
    } catch (error) {
      if (seq === sequence)
        $('searchStatus').textContent =
          error.message || 'Поиск недоступен. Попробуйте ссылку или поиск на сайте.';
    } finally {
      if (seq === sequence) $('searchSubmit').disabled = false;
    }
  });
  return { reset };
}
