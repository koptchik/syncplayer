// Deterministic catalog service only in the test server, never in production.
import { createApplication } from '../../src/server/app.mjs';
import { configuration } from '../../src/server/config.mjs';
import { createYummyResolver } from '../../src/server/yummy.mjs';
import { catalog, catalogUrl } from '../fixtures/catalog.mjs';
const liveResolver = createYummyResolver();
const config = configuration();
const application = await createApplication(config, {
  resolveCatalog: (url) =>
    url === catalogUrl ? Promise.resolve(structuredClone(catalog)) : liveResolver(url),
});
application.server.listen(config.port, config.host);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, async () => {
    await application.close();
    process.exit(0);
  });
