// Deterministic catalog service only in the test server, never in production.
import { createApplication } from '../../src/server/app.mjs';
import { configuration } from '../../src/server/config.mjs';
import { createYummyResolver } from '../../src/server/yummy.mjs';
import { catalog, catalogUrl } from '../fixtures/catalog.mjs';
const liveResolver = createYummyResolver();
const config = configuration();
const application = await createApplication(config, {
  searchSources: async ({ query }) => ({
    query,
    results: [
      {
        provider: 'rutube',
        url: 'https://rutube.ru/video/df566fac28e4853bbf4e6389a6d08cda/',
        title: 'Тестовый фильм Rutube',
        poster: 'https://pic.rtbcdn.ru/video/test.jpg',
      },
    ],
    sources: [
      { provider: 'rutube', available: true },
      { provider: 'yummy', available: false },
    ],
  }),
  enrichMedia: async (media) =>
    media.type === 'rutube'
      ? {
          ...media,
          title: media.title.startsWith('Rutube ·') ? 'Тестовый фильм Rutube' : media.title,
          poster: 'https://pic.rtbcdn.ru/video/test.jpg',
        }
      : media,
  resolveLordfilm: async (url) => {
    if (url !== 'https://8.lordfilms.mobile/1773/') throw new Error('Unknown fixture');
    return {
      type: 'lordfilm',
      title: 'Test movie',
      sourcePage: url,
      config: { titleId: '602749', publisherId: '2253' },
      live: false,
    };
  },
  resolveCatalog: (url) =>
    url === catalogUrl ? Promise.resolve(structuredClone(catalog)) : liveResolver(url),
});
application.server.listen(config.port, config.host);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, async () => {
    await application.close();
    process.exit(0);
  });
