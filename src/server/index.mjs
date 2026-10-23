import { configuration } from './config.mjs';
import { createApplication } from './app.mjs';
const config = configuration();
const application = await createApplication(config);
application.server.listen(config.port, config.host, () => {
  console.log(
    `Syncplayer is ready: ${config.publicOrigin || `http://${config.host}:${application.server.address().port}`}`,
  );
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    await application.close();
    process.exit(0);
  });
}
