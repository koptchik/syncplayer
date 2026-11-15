import { createApplication as productionApplication } from '../../src/server/app.mjs';
// Tests explicitly inject metadata I/O; production always uses the real bounded resolver.
export const createApplication = (config, options = {}) =>
  productionApplication(config, { enrichMedia: async (media) => media, ...options });
