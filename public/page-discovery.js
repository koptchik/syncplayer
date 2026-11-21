const $ = (id) => document.getElementById(id);
const labels = { youtube: 'YouTube', rutube: 'Rutube', twitch: 'Twitch', vimeo: 'Vimeo' };

export function createPageDiscovery({ request, choose, canSearch }) {
  const button = $('discoverSourceButton');
  const input = $('urlInput');
  const status = $('discoveryStatus');
  const list = $('discoveryResults');
  let controller;

  function reset() {
    controller?.abort();
    controller = null;
    button.disabled = false;
    status.textContent = '';
    list.replaceChildren();
  }

  button.addEventListener('click', async () => {
    reset();
    if (!canSearch()) return;
    const url = input.value.trim();
    if (!url || url.startsWith('<')) {
      status.textContent = 'Вставьте адрес HTTPS-страницы. Код iframe можно добавить напрямую.';
      return;
    }

    const pending = new AbortController();
    controller = pending;
    button.disabled = true;
    status.textContent = 'Ищем видео в HTML страницы…';
    try {
      const result = await request(
        url,
        AbortSignal.any([pending.signal, AbortSignal.timeout(8000)]),
      );
      if (pending !== controller) return;
      const count = result.candidates.length;
      const message = count
        ? `Найдено источников: ${count}. Выберите вариант для очереди.`
        : 'В HTML страницы не найдено поддерживаемых видео. Попробуйте прямую ссылку или код плеера.';
      status.textContent =
        message +
        (result.hasDash ? ' На странице есть DASH, его воспроизведение пока недоступно.' : '');
      for (const candidate of result.candidates) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'small-button';
        const url = new URL(candidate.url);
        const name = labels[candidate.provider] || candidate.format.toUpperCase();
        const filename = url.pathname.split('/').filter(Boolean).at(-1);
        item.textContent = `${name} · ${filename || url.hostname}`;
        item.addEventListener('click', () => {
          choose(candidate.url, result.title);
          reset();
          status.textContent = 'Источник выбран. Нажмите «Добавить в очередь».';
        });
        list.append(item);
      }
    } catch (error) {
      if (pending === controller) {
        status.textContent =
          error.name === 'TimeoutError'
            ? 'Поиск занял слишком много времени. Попробуйте ещё раз.'
            : error.message;
      }
    } finally {
      if (pending === controller) button.disabled = false;
    }
  });

  input.addEventListener('input', reset);
  $('addDialog').addEventListener('close', reset);
  return { reset };
}
